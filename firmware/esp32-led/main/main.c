#include "led_codec.h"
#include "led_pins.h"
#include "led_trace.h"
#include "led_transport.h"
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#include "driver/gpio.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "esp_random.h"
#include "esp_task_wdt.h"
#include "esp_timer.h"
#include "esp_transport.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "mqtt_client.h"
#include "mqtt5_client.h"
#include "nvs_flash.h"
#include "nvs.h"
_Static_assert(CONFIG_MQTT_POLL_READ_TIMEOUT_MS <= 20, "LED bench requires a short MQTT queue polling interval");
static const char *TAG = "open-apcs";
static apcs_led led;
static esp_mqtt_client_handle_t client;
static esp_transport_handle_t mqtt_transport;
static QueueHandle_t incoming;
static atomic_bool connected, disconnected, transport_fault, wifi_ready;
static char topic_in[300], topic_out[300], client_id[300];
static struct { char ssid[33], password[65], broker[257], username[129], secret[257], site[129], device[129], ca[4096], ntp[256]; int32_t gpio; } config;
typedef struct { size_t size; bool retained; char data[4096]; } packet;
static double now_ms(void) { return (double)esp_timer_get_time() / 1000.0; }
#if CONFIG_APCS_DIAGNOSTIC_TRACE
static QueueHandle_t trace_queue;
static atomic_uint trace_sequence, trace_dropped;
static void trace(apcs_trace_kind kind,const char *data,size_t size,int message_id) {
  apcs_trace_event e={.sequence=atomic_fetch_add(&trace_sequence,1)+1,.at_us=(uint64_t)esp_timer_get_time(),.event=kind,.hash=apcs_trace_hash(data,size),.size=(uint32_t)size,.message_id=message_id,.dropped=atomic_load(&trace_dropped)};
  if(!trace_queue || xQueueSend(trace_queue,&e,0)!=pdTRUE) atomic_fetch_add(&trace_dropped,1);
}
static void trace_drain(void *arg) {
  (void)arg; apcs_trace_event e; char line[256];
  for(;;) if(xQueueReceive(trace_queue,&e,portMAX_DELAY)==pdTRUE && apcs_trace_format(&e,line,sizeof(line))) puts(line);
}
#else
static void trace(apcs_trace_kind kind,const char *data,size_t size,int message_id) { (void)kind;(void)data;(void)size;(void)message_id; }
#endif
static bool string_key(nvs_handle_t handle, const char *key, char *dest, size_t size) { return nvs_get_str(handle, key, dest, &size) == ESP_OK && dest[0]; }
static bool load_config(void) {
  nvs_handle_t handle; if (nvs_open("apcs", NVS_READONLY, &handle) != ESP_OK) return false;
  bool ok = string_key(handle, "ssid", config.ssid, sizeof(config.ssid)) && string_key(handle, "password", config.password, sizeof(config.password)) && string_key(handle, "broker", config.broker, sizeof(config.broker)) && string_key(handle, "username", config.username, sizeof(config.username)) && string_key(handle, "secret", config.secret, sizeof(config.secret)) && string_key(handle, "site", config.site, sizeof(config.site)) && string_key(handle, "device", config.device, sizeof(config.device)) && string_key(handle, "ca", config.ca, sizeof(config.ca)) && string_key(handle, "ntp", config.ntp, sizeof(config.ntp)) && nvs_get_i32(handle, "gpio", &config.gpio) == ESP_OK;
  nvs_close(handle);
  return ok && apcs_led_pin_allowed(config.gpio) && apcs_identifier(config.site) && apcs_identifier(config.device) && strlen(config.password) >= 8 && !strncmp(config.broker, "mqtts://", 8) && !strchr(config.broker, '@');
}
static void wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
  (void)arg; (void)data;
  if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) { if (esp_wifi_connect() != ESP_OK) atomic_store(&transport_fault, true); }
  if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) atomic_store(&wifi_ready, true);
  if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) { atomic_store(&wifi_ready, false); atomic_store(&connected, false); atomic_store(&disconnected, true); }
}
static void mqtt_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
  (void)arg; (void)base; esp_mqtt_event_handle_t event = data;
  if (id == MQTT_EVENT_BEFORE_CONNECT) {
    /* Acquire the standard TLS transport at its documented lifecycle event. */
    mqtt_transport = esp_mqtt_client_get_transport(client, MQTT_OVER_SSL_SCHEME);
    if (!mqtt_transport) atomic_store(&transport_fault, true);
  } else if (id == MQTT_EVENT_CONNECTED) {
    /* The socket exists only after connection; the transport remains client-owned. */
    if (!mqtt_transport || !apcs_tcp_no_delay(esp_transport_get_socket(mqtt_transport))) {
      atomic_store(&transport_fault, true); return;
    }
    esp_mqtt5_subscribe_property_config_t property = { .retain_as_published_flag = true, .retain_handle = 2 };
    if (esp_mqtt5_client_set_subscribe_property(client, &property) != ESP_OK || esp_mqtt_client_subscribe(client, topic_in, 1) < 0) atomic_store(&transport_fault, true);
  } else if (id == MQTT_EVENT_SUBSCRIBED) atomic_store(&connected, true);
  else if (id == MQTT_EVENT_PUBLISHED) trace(APCS_TRACE_ACK,NULL,0,event->msg_id);
  else if (id == MQTT_EVENT_DISCONNECTED || id == MQTT_EVENT_ERROR) { trace(APCS_TRACE_DISCONNECT,NULL,0,0); atomic_store(&connected, false); atomic_store(&disconnected, true); }
  else if (id == MQTT_EVENT_DATA) {
    if (event->total_data_len < 1 || event->total_data_len > 4096 || event->current_data_offset != 0 || event->data_len != event->total_data_len || event->topic_len != (int)strlen(topic_in) || memcmp(event->topic, topic_in, (size_t)event->topic_len)) { atomic_store(&transport_fault, true); return; }
    trace(APCS_TRACE_RX,event->data,(size_t)event->data_len,event->msg_id);
    packet message = { .size = (size_t)event->data_len, .retained = event->retain != 0 }; memcpy(message.data, event->data, message.size);
    if (xQueueSend(incoming, &message, 0) != pdTRUE) atomic_store(&transport_fault, true);
  }
}
static void apply_output(void) { ESP_ERROR_CHECK(gpio_set_level((gpio_num_t)config.gpio, led.output ? 1 : 0)); }
static bool publish(const char *payload) {
  esp_mqtt5_publish_property_config_t property = { .message_expiry_interval = 1 };
  trace(APCS_TRACE_TX_ENTER,payload,strlen(payload),0);
  int id=esp_mqtt5_client_set_publish_property(client,&property)==ESP_OK ? esp_mqtt_client_enqueue(client,topic_out,payload,0,1,0,true) : -1;
  trace(APCS_TRACE_TX_EXIT,payload,strlen(payload),id);
  return id>=0;
}
static void control(void *arg) {
  (void)arg; ESP_ERROR_CHECK(esp_task_wdt_add(NULL)); double last_report = 0; bool reported_output = false; packet message; char reply[4096];
  for (;;) {
    double now = now_ms(); apcs_tick(&led, now);
    if (atomic_exchange(&disconnected, false) || atomic_load(&transport_fault)) { apcs_disconnect(&led); xQueueReset(incoming); }
    apply_output();
    if (atomic_load(&connected) && !atomic_load(&transport_fault)) {
      /* One packet per cycle bounds work; a flood faults the bounded ingress queue. */
      if (xQueueReceive(incoming, &message, 0) == pdTRUE) {
        trace(APCS_TRACE_PROCESS,message.data,message.size,0);
        bool response = apcs_frame(&led, message.data, message.size, message.retained, now, reply, sizeof(reply));
        apply_output(); if (response && !publish(reply)) atomic_store(&transport_fault, true);
      }
      if (apcs_report_due(&led, reported_output, last_report, now)) {
        if (!apcs_telemetry(&led, now, reply, sizeof(reply)) || !publish(reply)) atomic_store(&transport_fault, true);
        else { last_report = now; reported_output = led.output; }
      }
    }
    if (atomic_load(&transport_fault)) apcs_disconnect(&led);
    apply_output(); ESP_ERROR_CHECK(esp_task_wdt_reset()); vTaskDelay(pdMS_TO_TICKS(10));
  }
}
void app_main(void) {
  /* Never erase provisioning automatically on a storage error. */
  if (nvs_flash_init() != ESP_OK || !load_config()) { ESP_LOGE(TAG, "Valid local provisioning required; GPIO is not armed"); return; }
  ESP_ERROR_CHECK(gpio_set_level((gpio_num_t)config.gpio, 0));
  gpio_config_t gpio = { .pin_bit_mask = 1ULL << config.gpio, .mode = GPIO_MODE_OUTPUT, .pull_down_en = GPIO_PULLDOWN_ENABLE };
  ESP_ERROR_CHECK(gpio_config(&gpio));
  ESP_ERROR_CHECK(esp_netif_init()); ESP_ERROR_CHECK(esp_event_loop_create_default()); esp_netif_create_default_wifi_sta();
  wifi_init_config_t wifi_init = WIFI_INIT_CONFIG_DEFAULT(); ESP_ERROR_CHECK(esp_wifi_init(&wifi_init));
  ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event, NULL)); ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event, NULL));
  wifi_config_t wifi = {0}; memcpy(wifi.sta.ssid, config.ssid, strlen(config.ssid)); memcpy(wifi.sta.password, config.password, strlen(config.password)); wifi.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;
  ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM)); ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA)); ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi)); ESP_ERROR_CHECK(esp_wifi_start());
  /* USB-powered control bench: avoid DTIM sleep delaying the lease handshake. */
  ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_NONE));
  for (unsigned i = 0; i < 300 && !atomic_load(&wifi_ready); i++) vTaskDelay(pdMS_TO_TICKS(100));
  if (!atomic_load(&wifi_ready)) { ESP_LOGE(TAG, "Wi-Fi unavailable; output remains OFF"); return; }
  esp_sntp_config_t sntp = ESP_NETIF_SNTP_DEFAULT_CONFIG(config.ntp); ESP_ERROR_CHECK(esp_netif_sntp_init(&sntp));
  if (esp_netif_sntp_sync_wait(pdMS_TO_TICKS(15000)) != ESP_OK) { ESP_LOGE(TAG, "Local time service unavailable; TLS commissioning stopped"); return; }
  unsigned char random[16]; esp_fill_random(random, sizeof(random)); char boot[33]; for (size_t i = 0; i < sizeof(random); i++) snprintf(boot + 2 * i, 3, "%02x", random[i]);
  if (!apcs_init(&led, boot)) return;
  snprintf(topic_in, sizeof(topic_in), "openapcs/led/v1/%s/%s/in", config.site, config.device); snprintf(topic_out, sizeof(topic_out), "openapcs/led/v1/%s/%s/out", config.site, config.device); snprintf(client_id, sizeof(client_id), "apcs-%s-%s", config.site, config.device);
#if CONFIG_APCS_DIAGNOSTIC_TRACE
  trace_queue=xQueueCreate(64,sizeof(apcs_trace_event));
  if(!trace_queue || xTaskCreate(trace_drain,"apcs-trace",4096,NULL,1,NULL)!=pdPASS) { ESP_LOGE(TAG,"Diagnostic allocation failed; output remains OFF"); return; }
#endif
  incoming = xQueueCreate(4, sizeof(packet)); if (!incoming) { ESP_LOGE(TAG, "Ingress allocation failed; output remains OFF"); return; }
  esp_mqtt_client_config_t mqtt = { .broker.address.uri = config.broker, .broker.verification.certificate = config.ca, .credentials.client_id = client_id, .credentials.username = config.username, .credentials.authentication.password = config.secret, .session.protocol_ver = MQTT_PROTOCOL_V_5, .session.disable_clean_session = false, .network.disable_auto_reconnect = true, .buffer.size = 8192, .outbox.limit = 16384, .task.stack_size = 8192 };
  client = esp_mqtt_client_init(&mqtt); if (!client) return;
  ESP_ERROR_CHECK(esp_mqtt_client_register_event(client, ESP_EVENT_ANY_ID, mqtt_event, NULL));
  if (xTaskCreate(control, "apcs-control", 16384, NULL, 10, NULL) != pdPASS) { ESP_LOGE(TAG, "Control task allocation failed; output remains OFF"); return; }
  ESP_ERROR_CHECK(esp_mqtt_client_start(client));
  ESP_LOGI(TAG, "LED bench endpoint started; a fresh gateway lease is required");
}
