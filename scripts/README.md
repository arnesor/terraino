# Project-Local Scripts

Place scripts that use this project's dependencies or import `terraino` here.
Keep reusable logic under `src/terraino` and make scripts thin entry points.

Run a script from the project root:

```console
uv run scripts/example.py
```

Import the installed package name, not `src`:

```python
from terraino import functions
```
