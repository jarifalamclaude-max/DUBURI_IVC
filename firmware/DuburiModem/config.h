/*
 * config.h - the ONLY file you normally need to edit.
 *
 * Flash the same firmware on both boards. Give each one a different NODE_ID.
 */
#ifndef DUBURI_CONFIG_H
#define DUBURI_CONFIG_H

/* ---- Who am I ---------------------------------------------------------- */
#define NODE_ID          1    /* 1..14, different on every board              */
#define PEER_ID          2    /* default destination for messages/commands    */

/* ---- Medium: AIR or WATER ----------------------------------------------
 * AM_MODE_AIR   : speaker + MAX9814 mic module, through a room.
 *                 40 ms slots -> one packet = 2.56 s. Handles room echo.
 * AM_MODE_WATER : speaker in a sealed box + hydrophone, in a pool.
 *                 20 ms slots -> one packet = 1.28 s (original design).
 * BOTH boards must be in the same mode, or nothing is received.
 * You can also switch at run time: serial command "mode air" / "mode water"
 * (or the button on the web page). That choice is saved in flash and wins
 * over DEFAULT_MODE until you change it again. */
#define DEFAULT_MODE     AM_MODE_AIR

/* ---- Pins (ESP32 DevKit V1 / WROOM-32) --------------------------------- */
#define PIN_TX_AUDIO     25   /* square-wave tone out -> RC filter -> amp IN  */
#define PIN_RX_AUDIO     34   /* mic module / preamp out -> RC -> ADC1 ch 6   */
#define PIN_LED          2    /* on-board blue LED on most DevKit boards      */
#define PIN_BUTTON       0    /* BOOT button: press = send "toggle" to PEER   */
#define PIN_AMP_ENABLE   -1   /* amp SD/MUTE pin if your module has one, else -1 */
#define AMP_ENABLE_LEVEL HIGH /* level that turns the amp ON                  */

/* ---- Behaviour --------------------------------------------------------- */
#define USE_ACK          1    /* commands (on/off/ping): ask for a reply      */
#define TX_RETRIES       3    /* attempts per command                         */
#define REPEAT_GAP_MS    400  /* gap between repeats when USE_ACK = 0         */
#define TURNAROUND_MS    300  /* receiver waits this long before replying     */
#define DEDUP_MS         15000/* same (src,seq) inside this time = repeat     */
#define TEXT_REPEATS     1    /* "msg" command: send every packet this often  */

/* Echo tail to ignore after our own transmission (per mode), and the gap
 * between the packets of one text message (lets the echo die down; pool
 * echoes last ~0.35 s, see sim/air_sim.py). */
#define WATER_MUTE_TAIL_MS  120
#define AIR_MUTE_TAIL_MS    300
#define TEXT_GAP_MS         400

/* ---- Heat protection ----------------------------------------------------
 * A "heat bucket": every second of sound fills it, every second of silence
 * empties it. The speaker may play at most TX_DUTY of the time on average,
 * but a short message of up to BURST_S seconds can go out without pauses.
 * WATER: a sealed box cannot lose heat easily -> 50 %.
 * AIR  : needs far less volume (keep RV1 low) -> 75 %.
 * Lower these if the speaker gets warm (guide, chapter 7). */
#define WATER_TX_DUTY    0.50f
#define WATER_BURST_S    6.0f
#define AIR_TX_DUTY      0.75f
#define AIR_BURST_S      10.0f

#define SERIAL_BAUD      115200

#endif
