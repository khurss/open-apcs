#!/bin/sh
set -eu
umask 077
[ "$#" -eq 3 ] || { echo 'Usage: encode-nvs.sh PRIVATE.csv NEW.bin PARTITION_SIZE' >&2; exit 2; }
[ -f "$1" ] && [ "$(stat -c %a "$1")" = 600 ] || { echo 'Input CSV must be a private regular file (mode 0600).' >&2; exit 1; }
[ ! -e "$2" ] && [ ! -L "$2" ] || { echo 'Output already exists; refusing overwrite.' >&2; exit 1; }
python /opt/esp/idf/components/nvs_flash/nvs_partition_generator/nvs_partition_gen.py generate "$1" "$2" "$3"
chmod 600 "$2"
