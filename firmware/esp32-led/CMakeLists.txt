cmake_minimum_required(VERSION 3.16)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(open_apcs_led)
target_compile_definitions(__idf_json PRIVATE CJSON_NESTING_LIMIT=8)
