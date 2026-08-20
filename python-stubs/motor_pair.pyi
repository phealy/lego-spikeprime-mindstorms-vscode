"""Run paired motors in a synchronized fashion."""

from typing import Awaitable, Final, TypeAlias
import motor

MotorPair: TypeAlias = int

PAIR_1: Final[MotorPair] = 0
PAIR_2: Final[MotorPair] = 1
PAIR_3: Final[MotorPair] = 2

def move(
    pair: MotorPair,
    steering: int,
    *,
    velocity: int = 360,
    acceleration: int = 1000,
) -> None:
    """Move a motor pair continuously with steering."""
    ...

def move_for_degrees(
    pair: MotorPair,
    degrees: int,
    steering: int,
    *,
    velocity: int = 360,
    stop: motor.StopType = motor.BRAKE,
    acceleration: int = 1000,
    deceleration: int = 1000,
) -> Awaitable[motor.StateType]:
    """Return an awaitable that moves a pair through a number of degrees."""
    ...

def move_for_time(
    pair: MotorPair,
    duration: int,
    steering: int,
    *,
    velocity: int = 360,
    stop: motor.StopType = motor.BRAKE,
    acceleration: int = 1000,
    deceleration: int = 1000,
) -> Awaitable[motor.StateType]:
    """Return an awaitable that moves a pair for a duration in milliseconds."""
    ...

def move_tank(
    pair: MotorPair,
    left_velocity: int,
    right_velocity: int,
    *,
    acceleration: int = 1000,
) -> None:
    """Move a pair continuously with independent motor velocities."""
    ...

def move_tank_for_degrees(
    pair: MotorPair,
    degrees: int,
    left_velocity: int,
    right_velocity: int,
    *,
    stop: motor.StopType = motor.BRAKE,
    acceleration: int = 1000,
    deceleration: int = 1000,
) -> Awaitable[motor.StateType]:
    """Return an awaitable for a tank move through a number of degrees."""
    ...

def move_tank_for_time(
    pair: MotorPair,
    left_velocity: int,
    right_velocity: int,
    duration: int,
    *,
    stop: motor.StopType = motor.BRAKE,
    acceleration: int = 1000,
    deceleration: int = 1000,
) -> Awaitable[motor.StateType]:
    """Return an awaitable for a timed tank move."""
    ...

def pair(
    pair: MotorPair, left_motor: motor.Motor, right_motor: motor.Motor
) -> None:
    """Assign two motor ports to a pair slot."""
    ...

def stop(pair: MotorPair, *, stop: motor.StopType = motor.BRAKE) -> None:
    """Stop a motor pair using the requested stop behavior."""
    ...

def unpair(pair: MotorPair) -> None:
    """Remove motors from a pair slot."""
    ...