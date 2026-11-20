"""Student pass keys: generated codes that a parent uses to sign up for their child."""
import re
import secrets

# Capitals and digits without look-alikes (0/O, 1/I/L), so a key can be read out or typed from paper.
ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"


def grouped(characters: str) -> str:
    return "-".join(characters[index:index + 4] for index in range(0, 12, 4))


def new_pass_key() -> str:
    """A random key such as "K7QM-4XPD-9HTR": 12 characters in three groups."""
    return grouped("".join(secrets.choice(ALPHABET) for _ in range(12)))


def normalise_pass_key(text: str) -> str | None:
    """The stored form of a key someone typed: dashes, spaces, and letter case do not matter. None if it cannot be a key."""
    characters = re.sub(r"[\s-]", "", text.upper())
    return grouped(characters) if len(characters) == 12 and all(character in ALPHABET for character in characters) else None
