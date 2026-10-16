"""Command-line interface."""

import click


@click.command()
@click.version_option()
def main() -> None:
    """Otest."""


if __name__ == "__main__":
    main(prog_name="otest")  # pragma: no cover
