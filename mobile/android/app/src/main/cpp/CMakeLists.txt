# Native helper for the launcher: the seccomp SIGSYS shim that ServerService
# preloads into the server process (see seccomp_shim.c and AD-026).
cmake_minimum_required(VERSION 3.22.1)
project(vibetavern_native C)

add_library(seccompshim SHARED seccomp_shim.c)
target_compile_options(seccompshim PRIVATE -Wall -Wextra -Werror)
# 16 KB pages: required for Android 15+ devices with 16 KB page kernels.
target_link_options(seccompshim PRIVATE "-Wl,-z,max-page-size=16384")
