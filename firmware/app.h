/* SPDX-License-Identifier: MIT */
#pragma once
#include <stdint.h>
#include "plat.h"
#define APP_NAME "THREADBOARD"
#define APP_SPLASH_RGB RGB(120, 190, 255)
#define APP_BLOCK 256u
#define APP_CANVAS_PX (240u * 48u)
#define APP_USB_CMD
enum { OBJ_PANEL, OBJ_NOBJ };
#define APP_STORE_MAP {0xDC000u}
void app_init(void);
void app_render(int32_t *lr, uint32_t n, uint32_t master_q12);
void app_panic(void);
void app_ui_init(void);
void app_frame(void);
void app_input_only(void);
void app_say(const char *a, const char *b);
void app_usb_cmd(const uint8_t *data, uint32_t n);
#define APP_HOST_EXPECT
#define APP_HOST_CMD
#define APP_HOST_REBOOT
int app_expect(const char *what, int *got);
int app_host_cmd(const char *cmd, const char *a, const char *b, const char *c, const char *d);
void app_host_reboot(void);
