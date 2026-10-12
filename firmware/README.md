# PIC firmware integration

The executable reference model defines control behavior. It is not a compiled PIC firmware image. Porting to mikroC requires the actual board, library configuration and hardware verification.

## Suggested source structure

| Module | Responsibility |
|---|---|
| main.c | Startup, cooperative foreground task dispatch |
| board.h | Pin map, active levels and provisioned configuration |
| timebase.c | Timer2 tick; atomic snapshot of shared tick counter |
| analog.c | LM35 ADC acquisition, averaging and calibration |
| sht31.c | Measurement command, deadline, CRC and humidity conversion |
| rtc.c | DS1307 I²C reads, BCD conversion, CH/range validation |
| keypad.c | Matrix scan, debounce, press/release, masked entry |
| control.c | Cooling hysteresis and measurement validity |
| access.c | Timed release, exit edge and keypad lockout |
| alarms.c | Active fault set, priority and acknowledge/rearm |
| settings.c | EEPROM record, CRC, slot selection and range validation |
| lcd_ui.c | Non-blocking alternating 16-character screens |

## Bring-up sequence

1. Verify power and reset with loads disconnected. Set output latch bits LOW before changing TRIS.
2. Select HS oscillator for the 8 MHz reference crystal, disable LVP, configure brownout and ICSP. Confirm fuse selections for the selected device.
3. Disable comparators as required; set ADC configuration so AN0 is analog and RA1/RA2 are digital. Check ADC acquisition and conversion clock against the device data sheet.
4. Configure MSSP I²C at 100 kHz, verify ACK handling, deadlines and bus recovery with the installed library. Check address-byte versus 7-bit-address conventions.
5. Validate LCD pin aliases and keypad isolation from RB6/RB7 during programming.
6. Configure Timer2: prescaler 1:16, PR2 = 249, postscaler 1:2 for nominal 4 ms at Fosc 8 MHz. Clear its flag and enable the peripheral/global interrupt path. Scope the actual interval.
7. Read the shared tick atomically. Ensure unsigned counter wrap comparisons work; no slow I²C/LCD/storage operation in ISR.
8. Implement the settings serializer exactly; use the PIC EEPROM write-completion rules and preserve interrupt state. Do not introduce a long fixed delay as a universal write specification.
9. Verify timebase behavior during saves. Defer settings saves during an active lock release or account for masked interrupt intervals.
10. Compile with the installed mikroC version and selected libraries, record memory use, flash the PIC, then execute the commissioning plan.

## Example control routine (mikroC style)

```c
/* Reference logic only; not a complete board program. */
unsigned short fan_command = 0;
void cooling_update(unsigned short temperature_valid,
                    unsigned int temperature_tenths,
                    unsigned int off_tenths,
                    unsigned int on_tenths) {
  if (!temperature_valid) fan_command = 1;
  else if (temperature_tenths >= on_tenths) fan_command = 1;
  else if (temperature_tenths <= off_tenths) fan_command = 0;
  /* Apply to the configured fan-driver pin in foreground. */
}
```

The full hardware-specific source, compiler project and HEX require board-level completion. Original training libraries retain their attribution; they are not republished as newly authored complete firmware.
