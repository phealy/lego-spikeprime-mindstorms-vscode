"""Control and query individual motors attached to the hub."""

from typing import Awaitable, Final, TypeAlias

Motor: TypeAlias = int
StateType: TypeAlias = int
StopType: TypeAlias = int
DirectionType: TypeAlias = int
MotorState: TypeAlias = int
MotorBrakeMode: TypeAlias = int
MotorDirection: TypeAlias = int

READY: Final[StateType] = 0
RUNNING: Final[StateType] = 1
STALLED: Final[StateType] = 2
CANCELLED: Final[StateType] = 3
ERROR: Final[StateType] = 4
DISCONNECTED: Final[StateType] = 5
COAST: Final[StopType] = 0
BRAKE: Final[StopType] = 1
STOP: Final[StopType] = BRAKE
HOLD: Final[StopType] = 2
CONTINUE: Final[StopType] = 3
SMART_COAST: Final[StopType] = 4
SMART_BRAKE: Final[StopType] = 5
CLOCKWISE: Final[DirectionType] = 0
COUNTERCLOCKWISE: Final[DirectionType] = 1
SHORTEST_PATH: Final[DirectionType] = 2
LONGEST_PATH: Final[DirectionType] = 3

def absolute_position(port: Motor) -> int:
    """Return absolute motor position from -179 to 180 degrees."""
    ...

def get_duty_cycle(port: Motor) -> int:
    """Return the motor PWM duty cycle."""
    ...

def relative_position(port: Motor) -> int:
    """Return cumulative motor position in degrees."""
    ...

def reset_relative_position(port: Motor, position: int) -> None:
    """Set the reference used for relative motor position."""
    ...

def run(port: Motor, velocity: int, *, acceleration: int = 1000) -> None:
    """Run a motor continuously at a constant velocity."""
    ...

def run_for_degrees(
    port: Motor,
    degrees: int,
    velocity: int,
    *,
    stop: StopType = BRAKE,
    acceleration: int = 1000,
    deceleration: int = 1000,
) -> Awaitable[StateType]:
    """Return an awaitable that runs a motor through a number of degrees."""
    ...

def run_for_time(
    port: Motor,
    duration: int,
    velocity: int,
    *,
    stop: StopType = BRAKE,
    acceleration: int = 1000,
    deceleration: int = 1000,
) -> Awaitable[StateType]:
    """Return an awaitable that runs a motor for a duration in milliseconds."""
    ...

def run_to_absolute_position(
    port: Motor,
    position: int,
    velocity: int,
    *,
    direction: DirectionType = SHORTEST_PATH,
    stop: StopType = BRAKE,
    acceleration: int = 1000,
    deceleration: int = 1000,
) -> Awaitable[StateType]:
    """Return an awaitable that moves a motor to an absolute position."""
    ...

def run_to_relative_position(
    port: Motor,
    position: int,
    velocity: int,
    *,
    stop: StopType = BRAKE,
    acceleration: int = 1000,
    deceleration: int = 1000,
) -> Awaitable[StateType]:
    """Return an awaitable that moves a motor to a relative position."""
    ...

def set_duty_cycle(port: Motor, pwm: int) -> None:
    """Start a motor with a specific PWM duty cycle."""
    ...

def stop(port: Motor, *, stop: StopType = BRAKE) -> None:
    """Stop a motor using the requested stop behavior."""
    ...

def velocity(port: Motor) -> int:
    """Return motor velocity."""
    ...

def status(port: Motor) -> StateType:
    """Return the undocumented motor status value."""
    ...

def info(port: Motor) -> tuple[int, int]:
    """Return the undocumented device ID and maximum speed."""
    ...