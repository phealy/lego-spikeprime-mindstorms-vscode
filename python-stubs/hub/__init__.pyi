"""Query and control the HubOS3 hub itself."""

def device_uuid() -> str:
    """Return the device UUID."""
    ...

def hardware_id() -> str:
    """Return the hardware ID."""
    ...

def power_off() -> int:
    """Power off the hub."""
    ...

def temperature() -> int:
    """Return hub temperature in degrees Celsius."""
    ...

def soft_reset() -> int:
    """Perform an undocumented soft reset."""
    ...

def reset() -> int:
    """Perform an undocumented reset."""
    ...

def bootloader() -> int:
    """Enter the undocumented bootloader mode."""
    ...

def battery_voltage() -> int:
    """Return undocumented battery voltage in millivolts."""
    ...

def battery_temperature() -> int:
    """Return undocumented battery temperature."""
    ...

def battery_current() -> int:
    """Return undocumented battery current in milliamps."""
    ...

def usb_charge_current() -> int:
    """Return undocumented USB charge current in milliamps."""
    ...