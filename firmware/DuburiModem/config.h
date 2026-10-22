/*
 * config.h - the ONLY file you normally need to edit.
 *
 * Flash the same firmware on both vehicles. Give each one a different NODE_ID.
 */
#ifndef DUBURI_CONFIG_H
#define DUBURI_CONFIG_H

/* ---- Who am I ---------------------------------------------------------- */
#define NODE_ID          1    /* 1..14, different on every vehicle            */
#define PEER_ID          2    /* default destination for commands             */

/* ---- Pins (ESP32 DevKit V1 / WROOM-32) --------------------------------- */
#define PIN_TX_AUDIO     25   /* square-wave tone out -> RC filter -> amp IN  */
#define PIN_HYDROPHONE   34   /* preamp output -> ADC1 channel 6 (input only) */
#define PIN_LED          2    /* on-board blue LED on most DevKit boards      */
#define PIN_BUTTON       0    /* BOOT button: press = send "toggle" to PEER   */
#define PIN_AMP_ENABLE   -1   /* amp SD/MUTE pin if your module has one, else -1 */
#define AMP_ENABLE_LEVEL HIGH /* level that turns the amp ON                  */

/* ---- Behaviour --------------------------------------------------------- */
#define USE_ACK          1    /* 1 = ask for a reply and retry if none comes  */
#define TX_RETRIES       3    /* attempts per command                         */
#define ACK_TIMEOUT_MS   2600 /* wait this long for a reply                   */
#define REPEAT_GAP_MS    400  /* gap between repeats when USE_ACK = 0         */
#define TURNAROUND_MS    300  /* receiver waits this long before replying     */
#define MUTE_TAIL_MS     120  /* keep RX deaf this long after our own TX      */
#define DEDUP_MS         15000/* same (src,seq) inside this time = repeat     */

/* ---- Heat protection ----------------------------------------------------
 * Limits how much of the time the speaker may be playing. 0.5 means every
 * transmission must be followed by at least the same amount of silence
 * (a 1.16 s packet -> >= 1.16 s rest). Lower it if the speaker gets warm. */
#define MAX_TX_DUTY      0.5f

#define SERIAL_BAUD      115200

#endif
