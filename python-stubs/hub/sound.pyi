"""Play tones through the hub speaker."""

from typing import Awaitable, Final, TypeAlias

SoundChannel: TypeAlias = int
Waveform: TypeAlias = int

ANY: Final[SoundChannel] = -2
DEFAULT: Final[SoundChannel] = -1
WAVEFORM_SINE: Final[Waveform] = 0
WAVEFORM_TRIANGLE: Final[Waveform] = 1
WAVEFORM_SQUARE: Final[Waveform] = 2
WAVEFORM_SAWTOOTH: Final[Waveform] = 3

def beep(
    freq: int = 440,
    duration: int = 500,
    volume: int = 100,
    *,
    attack: int = 0,
    decay: int = 0,
    sustain: int = 100,
    release: int = 0,
    transition: int = 10,
    waveform: Waveform = WAVEFORM_SINE,
    channel: SoundChannel = DEFAULT,
) -> Awaitable[None]:
    """Return an awaitable that plays a tone."""
    ...

def stop() -> None:
    """Stop all sounds."""
    ...

def volume(volume: int) -> None:
    """Set speaker volume from 0 to 100."""
    ...

def sound(unknown: object) -> None:
    """Undocumented; behavior and parameter meaning are unknown."""
    ...