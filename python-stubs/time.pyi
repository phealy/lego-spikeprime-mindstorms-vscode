"""Time functions available in the HubOS3 runtime."""

def sleep(seconds: float) -> None:
    """Pause execution for the given number of seconds."""
    ...

def sleep_ms(milliseconds: int) -> None:
    """Pause execution for the given number of milliseconds."""
    ...

def ticks_ms() -> int:
    """Return the milliseconds elapsed since the program started."""
    ...