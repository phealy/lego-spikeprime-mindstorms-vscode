"""Run asynchronous HubOS3 programs."""

from typing import Awaitable, Callable, Final, Iterator, TypeAlias

RunloopStatus: TypeAlias = int

WAITING: Final[RunloopStatus] = 0
SUCCESS: Final[RunloopStatus] = 1
TIMEOUT: Final[RunloopStatus] = 2
CANCELLED: Final[RunloopStatus] = 3

def run(*functions: Awaitable[object]) -> None:
    """Run any number of asynchronous functions in parallel."""
    ...

def sleep_ms(duration: int) -> Awaitable[None]:
    """Return an awaitable that pauses for a number of milliseconds."""
    ...

def until(
    function: Callable[[], bool], timeout: int = 0
) -> Awaitable[RunloopStatus]:
    """Wait until a condition is true or the optional timeout elapses."""
    ...

def wait(unknown: Iterator[object]) -> Awaitable[object]:
    """Undocumented; behavior is not known."""
    ...