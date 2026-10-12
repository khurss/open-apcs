#!/bin/sh
set -eu
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT INT TERM
cc -DCJSON_NESTING_LIMIT=8 -std=c11 -Wall -Wextra -Werror -pedantic -fsanitize=address,undefined -fno-omit-frame-pointer -g -I main main/led_core.c tests/core_test.c -lm -o "$out/core-test"
"$out/core-test"
json=/opt/esp/idf/components/json/cJSON
cc -DCJSON_NESTING_LIMIT=8 -std=c11 -Wall -Wextra -Werror -pedantic -fsanitize=address,undefined -fno-omit-frame-pointer -g -I main -I "$json" main/led_core.c main/led_codec.c "$json/cJSON.c" tests/codec_test.c -lm -o "$out/codec-test"
"$out/codec-test"
mkdir -p /workspace/.cache/firmware-native
cc -DCJSON_NESTING_LIMIT=8 -std=c11 -Wall -Wextra -Werror -pedantic -static -O2 -I main -I "$json" main/led_core.c main/led_codec.c "$json/cJSON.c" tests/harness.c -lm -o "$out/led-peer"
mv "$out/led-peer" /workspace/.cache/firmware-native/led-peer
