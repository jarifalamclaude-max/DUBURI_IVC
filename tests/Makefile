CORE = ../firmware/DuburiModem/am_core.c
CFLAGS = -O2 -std=c99 -Wall -Wextra -Wdouble-promotion -Wfloat-conversion

all: test_core ../sim/libamcore.so ../sim/libamcore_notrack.so

test_core: test_core.c $(CORE) ../firmware/DuburiModem/am_core.h
	$(CC) $(CFLAGS) -o $@ test_core.c $(CORE) -lm

../sim/libamcore.so: $(CORE) ../firmware/DuburiModem/am_core.h
	$(CC) $(CFLAGS) -DAM_SIM -shared -fPIC -o $@ $(CORE) -lm

../sim/libamcore_notrack.so: $(CORE) ../firmware/DuburiModem/am_core.h
	$(CC) $(CFLAGS) -DAM_SIM -DAM_TRACK_ENABLE=0 -shared -fPIC -o $@ $(CORE) -lm

clean:
	rm -f test_core ../sim/libamcore.so
