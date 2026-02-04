# Instructions for Generative AI

- To run individual unit tests:
  1. Use a local virtual environment rooted at the source of this repository,
     for example `<repo>/.venv`.
  2. Activate the virtual environment with `source <path-to-env>/bin/activate`.
  3. Install the development version of `lnt` from the current tree with
     `pip install "<repo/root>[dev]"`.
  4. Run the test(s) from within the activated environment with `lit -sv <path/to/tests>`.

- When making changes, always consider what tests should be added or removed, and
  what documentation should be updated.

- When making a refactoring or a removal, also pay attention to what other
  related refactorings or removals could be unlocked by the current one.

- When making changes, consider the fact that the production server runs using
  multiple processes, unlike the development server we use during development.
