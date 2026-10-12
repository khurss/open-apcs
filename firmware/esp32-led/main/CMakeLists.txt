idf_component_register(SRCS "main.c" "led_core.c" "led_codec.c" INCLUDE_DIRS "." REQUIRES esp_wifi esp_event esp_netif nvs_flash mqtt json esp_driver_gpio esp_timer esp_system)
