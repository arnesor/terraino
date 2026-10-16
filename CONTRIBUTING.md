# Contributor Guide

Thank you for your interest in improving this project.
This project is open-source under the [MIT license]
and welcomes contributions in the form of bug reports, feature requests, and pull requests.

Here is a list of important resources for contributors:

- [Source Code]
- [Issue Tracker]
- [Code of Conduct]

## How to report a bug

Report bugs on the [Issue Tracker].

When filing an issue, make sure to answer these questions:

- Which operating system and Python version are you using?
- Which version of this project are you using?
- What did you do?
- What did you expect to see?
- What did you see instead?

The best way to get your bug fixed is to provide a test case, and/or steps to reproduce the issue.

## How to request a feature

Request features on the [Issue Tracker].

## How to set up your development environment

You need Python 3.12+ and [uv]:

1. Install [uv] if you haven't already.
   Refer to the [uv installation guide](https://docs.astral.sh/uv/getting-started/installation/).
2. Synchronize the development virtual environment and dependencies:

   ```console
   uv sync
   ```

3. Install the pre-commit hooks:

   ```console
   uv run pre-commit install
   ```

You can now run an interactive Python session, or your app:

```console
uv run python
uv run otest
```

## How to test the project

We run several types of checks on the codebase.

### Run Unit Tests

Unit tests are located in the `tests/` directory
and are written using the [pytest] testing framework.
Run them with coverage:

```console
uv run coverage run -m pytest
uv run coverage report
```

### Run Type Checking

Type check the source files and tests using [mypy]:

```console
uv run mypy src tests
```

### Run Linting & Formatting

Check Markdown and Python formatting and lint rules using [rumdl] and [ruff]:

```console
uv run rumdl check .
uv run ruff check
uv run ruff format --check
```

To automatically format the code and fix auto-fixable lint issues:

```console
uv run rumdl check --fix .
uv run ruff check --fix
uv run ruff format
```

### Run Documentation Examples Check

Run doctests using [xdoctest]:

```console
uv run python -m xdoctest --modname=otest --command=all
```

### Run Dependency Checks

Check that declared and imported dependencies agree:

```console
uv run deptry .
```

## How to release a new version

Update `project.version` in `pyproject.toml` using semantic versioning
and merge the change into `main` or `master`.
After all CI checks pass, Release Drafter publishes a GitHub release tagged with the new version.
GitHub releases contain source archives only.

## How to submit changes

Open a [pull request] to submit changes to this project.

Your pull request needs to meet the following guidelines for acceptance:

- The test suite must pass without errors and warnings.
- Include unit tests and maintain the configured coverage threshold.

Feel free to submit early, though—we can always iterate on this.

It is recommended to open an issue before starting work on anything.
This will allow a chance to talk it over with the owners and validate your approach.

[mit license]: https://opensource.org/licenses/MIT
[source code]: https://github.com/arnesor/otest
[issue tracker]: https://github.com/arnesor/otest/issues
[uv]: https://github.com/astral-sh/uv
[pytest]: https://pytest.org/
[mypy]: https://mypy.org/
[ruff]: https://github.com/astral-sh/ruff
[rumdl]: https://github.com/rvben/rumdl
[xdoctest]: https://github.com/Erotemic/xdoctest
[pull request]: https://github.com/arnesor/otest/pulls

<!-- github-only -->

[code of conduct]: CODE_OF_CONDUCT.md
