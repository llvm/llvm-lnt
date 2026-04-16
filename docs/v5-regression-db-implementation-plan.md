# v5 Regression DB Layer -- Implementation Plan

This plan covers the DB layer changes needed to implement the redesigned
regression model described in `docs/design/db/data-model.md` (D5) and `docs/design/db/operations.md` (D8).

**Goal**: Drop FieldChange, rewrite Regression and RegressionIndicator models
to match the design doc, update all CRUD methods and tests.

## Files modified (complete list)

| File | Change |
|------|--------|
| `lnt/server/db/v5/models.py` | Drop FieldChange model, update Regression + RegressionIndicator, update SuiteModels dataclass, update back-references |
| `lnt/server/db/v5/__init__.py` | Update REGRESSION_STATES (7 to 5), drop FieldChange CRUD, rewrite Regression + Indicator CRUD, update `delete_commit` |
| `tests/server/db/v5/test_models.py` | Drop FieldChange model tests, add new Regression/Indicator model tests |
| `tests/server/db/v5/test_crud.py` | Drop FieldChange CRUD tests, rewrite Regression + Indicator CRUD tests |
| `lnt/server/db/v5/schema.py` | No changes (FieldChange is not referenced) |

**Out of scope** (API + UI, separate plan): The API endpoints in
`lnt/server/api/v5/endpoints/regressions.py`, `field_changes.py`, helpers,
and schemas all need rewriting too, but that is not covered here.


---

## 1. Model changes (`models.py`)

File: `lnt/server/db/v5/models.py`

### 1a. Update `SuiteModels` dataclass -- drop `FieldChange` attribute

Lines 99-111. Remove the `FieldChange` field entirely.

**Before** (line 108):
```python
@dataclass
class SuiteModels:
    """Container for all SQLAlchemy model classes of a single test suite."""
    base: Any                    # declarative base
    Commit: Any = None
    Machine: Any = None
    Run: Any = None
    Test: Any = None
    Sample: Any = None
    FieldChange: Any = None      # <-- DELETE this line
    Regression: Any = None
    RegressionIndicator: Any = None
```

**After**:
```python
@dataclass
class SuiteModels:
    """Container for all SQLAlchemy model classes of a single test suite."""
    base: Any                    # declarative base
    Commit: Any = None
    Machine: Any = None
    Run: Any = None
    Test: Any = None
    Sample: Any = None
    Regression: Any = None
    RegressionIndicator: Any = None
```

### 1b. Delete the entire FieldChange model block

Delete lines 262-312 (the `# FieldChange` section, including the `fc_attrs`
dict, `FieldChange = type(...)`, and the compound index on
`FieldChange.machine_id, FieldChange.test_id, FieldChange.field_name`).

This removes:
- The `{prefix}_FieldChange` table definition
- All its columns: `id`, `uuid`, `test_id` (FK), `machine_id` (FK),
  `field_name`, `start_commit_id` (FK), `end_commit_id` (FK),
  `old_value`, `new_value`
- Relations: `test`, `machine`, `start_commit`, `end_commit`
- The compound index `ix_{prefix}_FieldChange_machine_test_field`

### 1c. Update the Regression model -- add `commit_id` FK and `notes` column

Lines 316-328. The current Regression model has: `id`, `uuid`, `title`, `bug`,
`state`. The design doc adds two columns:

- `commit_id`: Integer FK -> Commit, nullable, indexed
- `notes`: Text, nullable

**Before** (lines 317-328):
```python
    reg_attrs: dict[str, Any] = {
        "__tablename__": f"{prefix}_Regression",
        "id": Column("id", Integer, primary_key=True),
        "uuid": Column(
            "uuid", String(36), unique=True, nullable=False, index=True,
            default=lambda: str(uuid_module.uuid4()),
        ),
        "title": Column("title", String(256), nullable=True),
        "bug": Column("bug", String(256), nullable=True),
        "state": Column("state", Integer, nullable=False, index=True),
    }
    Regression = type("Regression", (base,), reg_attrs)
```

**After**:
```python
    reg_attrs: dict[str, Any] = {
        "__tablename__": f"{prefix}_Regression",
        "id": Column("id", Integer, primary_key=True),
        "uuid": Column(
            "uuid", String(36), unique=True, nullable=False, index=True,
            default=lambda: str(uuid_module.uuid4()),
        ),
        "title": Column("title", String(256), nullable=True),
        "bug": Column("bug", String(256), nullable=True),
        "notes": Column("notes", Text, nullable=True),
        "state": Column("state", Integer, nullable=False, index=True),
        "commit_id": Column(
            "commit_id", Integer,
            ForeignKey(f"{prefix}_Commit.id"),
            nullable=True, index=True,
        ),
        "commit_obj": relation(
            "Commit", foreign_keys=f"{prefix}_Regression.c.commit_id",
        ),
    }
    Regression = type("Regression", (base,), reg_attrs)
```

Key design decisions for `commit_id`:
- **No `ondelete="CASCADE"`**. The design doc (D5, Commit section) says
  "Commits referenced by a Regression's commit_id cannot be deleted (the API
  returns 409)." So we use the default `RESTRICT` behavior -- the DB itself
  prevents deletion of a commit that is referenced by a regression. The API
  layer catches the IntegrityError and returns 409.
- The relation is named `commit_obj` (same pattern as `Run.commit_obj`) to
  avoid collision with Python builtins.

### 1d. Rewrite the RegressionIndicator model

Lines 333-359. Completely replace. The current model has `field_change_id` FK
and a unique constraint on `(regression_id, field_change_id)`. The new model
replaces this with `uuid`, `machine_id` FK, `test_id` FK, `metric` string,
and a unique constraint on `(regression_id, machine_id, test_id, metric)`.

**Before** (lines 333-359):
```python
    ri_attrs: dict[str, Any] = {
        "__tablename__": f"{prefix}_RegressionIndicator",
        "id": Column("id", Integer, primary_key=True),
        "regression_id": Column(
            "regression_id", Integer,
            ForeignKey(f"{prefix}_Regression.id", ondelete="CASCADE"),
            nullable=False, index=True,
        ),
        "field_change_id": Column(
            "field_change_id", Integer,
            ForeignKey(f"{prefix}_FieldChange.id", ondelete="CASCADE"),
            nullable=False, index=True,
        ),
        "__table_args__": (
            UniqueConstraint("regression_id", "field_change_id",
                             name=f"uq_{prefix}_ri_regression_fieldchange"),
        ),
        "regression": relation(
            "Regression",
            foreign_keys=f"{prefix}_RegressionIndicator.c.regression_id",
        ),
        "field_change": relation(
            "FieldChange",
            foreign_keys=f"{prefix}_RegressionIndicator.c.field_change_id",
        ),
    }
    RegressionIndicator = type("RegressionIndicator", (base,), ri_attrs)
```

**After**:
```python
    ri_attrs: dict[str, Any] = {
        "__tablename__": f"{prefix}_RegressionIndicator",
        "id": Column("id", Integer, primary_key=True),
        "uuid": Column(
            "uuid", String(36), unique=True, nullable=False, index=True,
            default=lambda: str(uuid_module.uuid4()),
        ),
        "regression_id": Column(
            "regression_id", Integer,
            ForeignKey(f"{prefix}_Regression.id", ondelete="CASCADE"),
            nullable=False, index=True,
        ),
        "machine_id": Column(
            "machine_id", Integer,
            ForeignKey(f"{prefix}_Machine.id"),
            nullable=False, index=True,
        ),
        "test_id": Column(
            "test_id", Integer,
            ForeignKey(f"{prefix}_Test.id"),
            nullable=False, index=True,
        ),
        "metric": Column("metric", String(256), nullable=False),
        "__table_args__": (
            UniqueConstraint(
                "regression_id", "machine_id", "test_id", "metric",
                name=f"uq_{prefix}_ri_reg_machine_test_metric",
            ),
        ),
        "regression": relation(
            "Regression",
            foreign_keys=f"{prefix}_RegressionIndicator.c.regression_id",
        ),
        "machine": relation(
            "Machine",
            foreign_keys=f"{prefix}_RegressionIndicator.c.machine_id",
        ),
        "test": relation(
            "Test",
            foreign_keys=f"{prefix}_RegressionIndicator.c.test_id",
        ),
    }
    RegressionIndicator = type("RegressionIndicator", (base,), ri_attrs)
```

Key decisions for `machine_id` and `test_id` FKs on RegressionIndicator:
- **No `ondelete="CASCADE"`** on `machine_id` and `test_id`. We do not want
  deleting a machine or test to silently wipe regression indicators. If a
  machine/test is deleted while indicators reference it, the DB should block
  the delete (default RESTRICT). This is a safety choice -- regressions are
  triage artifacts and should not vanish when the underlying entities change.
- `regression_id` keeps `ondelete="CASCADE"` -- deleting a regression should
  always cascade to its indicators.

### 1e. Update back-references

Lines 363-405. Three changes:

1. **Delete** the `FieldChange.regression_indicators` back-reference (lines
   392-398). This block no longer exists because FieldChange is gone:
   ```python
   # DELETE this entire block:
   FieldChange.regression_indicators = relation(
       RegressionIndicator,
       foreign_keys=[RegressionIndicator.field_change_id],
       back_populates="field_change",
       cascade="all, delete-orphan",
       passive_deletes=True,
   )
   ```

2. **Keep** the `Regression.indicators` back-reference (lines 399-405)
   unchanged. It still cascades via `regression_id`.

3. **No new back-references needed** on Machine or Test for indicators.
   The `machine` and `test` relations on RegressionIndicator are forward-only
   lookups; we do not need `Machine.regression_indicators` or
   `Test.regression_indicators` collections.

### 1f. Update the `return SuiteModels(...)` call

Lines 407-417. Remove `FieldChange=FieldChange` from the constructor.

**Before** (lines 407-417):
```python
    return SuiteModels(
        base=base,
        Commit=Commit,
        Machine=Machine,
        Run=Run,
        Test=Test,
        Sample=Sample,
        FieldChange=FieldChange,
        Regression=Regression,
        RegressionIndicator=RegressionIndicator,
    )
```

**After**:
```python
    return SuiteModels(
        base=base,
        Commit=Commit,
        Machine=Machine,
        Run=Run,
        Test=Test,
        Sample=Sample,
        Regression=Regression,
        RegressionIndicator=RegressionIndicator,
    )
```

### 1g. Summary of table count change

Before: 8 per-suite tables (Commit, Machine, Run, Test, Sample, FieldChange,
Regression, RegressionIndicator).
After: 7 per-suite tables (FieldChange dropped).


---

## 2. State machine changes (`__init__.py`)

File: `lnt/server/db/v5/__init__.py`, lines 34-43.

The current `REGRESSION_STATES` has 7 entries (0-6):
```python
REGRESSION_STATES = {
    0: "detected",
    1: "staged",
    2: "active",
    3: "not_to_be_fixed",
    4: "ignored",
    5: "fixed",
    6: "detected_fixed",
}
```

The design doc specifies 5 states (0-4):
```python
REGRESSION_STATES = {
    0: "detected",
    1: "active",
    2: "not_to_be_fixed",
    3: "fixed",
    4: "false_positive",
}
```

Replace the entire dict. `VALID_REGRESSION_STATES` (line 43) derives from
this dict and needs no separate change.

**Impact**: The validation function `_validate_regression_state()` (line
260-266) uses `VALID_REGRESSION_STATES` and needs no code change -- it
automatically reflects the new dict. However, any existing test data or API
code using old state names (`staged`, `ignored`, `detected_fixed`) or old
numeric values (5, 6) will break. This is intentional: v5 is a clean break.


---

## 3. CRUD method changes (`__init__.py`)

File: `lnt/server/db/v5/__init__.py`

### 3a. Drop the `self.FieldChange` attribute from `V5TestSuiteDB.__init__`

Line 288. Delete `self.FieldChange = models.FieldChange`.

### 3b. Update `delete_commit()` -- remove FieldChange guard

Lines 419-452. The current implementation checks for FieldChanges referencing
the commit (via `start_commit_id`/`end_commit_id`) and blocks deletion. Since
FieldChange is dropped, this guard must be replaced.

The design doc says: "Commits referenced by a Regression's commit_id cannot
be deleted (the API returns 409)." The DB-level FK constraint (RESTRICT) on
`Regression.commit_id -> Commit.id` will prevent the deletion at the database
level. The CRUD method should catch this.

**Before** (lines 419-452):
```python
    def delete_commit(
        self,
        session: sqlalchemy.orm.Session,
        commit_id: int,
    ) -> None:
        """Delete a commit by ID (cascades to runs and samples).

        Raises ``ValueError`` if any FieldChanges reference this commit
        (via ``start_commit_id`` or ``end_commit_id``).  Those must be
        deleted first.
        """
        commit = session.query(self.Commit).get(commit_id)
        if commit is None:
            return

        fc_count = (
            session.query(self.FieldChange)
            .filter(
                or_(
                    self.FieldChange.start_commit_id == commit_id,
                    self.FieldChange.end_commit_id == commit_id,
                )
            )
            .count()
        )
        if fc_count > 0:
            raise ValueError(
                f"Cannot delete commit {commit_id}: "
                f"{fc_count} FieldChange(s) reference it; "
                f"delete them first"
            )

        session.delete(commit)
        session.flush()
```

**After**:
```python
    def delete_commit(
        self,
        session: sqlalchemy.orm.Session,
        commit_id: int,
    ) -> None:
        """Delete a commit by ID (cascades to runs and samples).

        Raises ``ValueError`` if any Regressions reference this commit
        (via ``commit_id``).  Those must be updated first.
        """
        commit = session.query(self.Commit).get(commit_id)
        if commit is None:
            return

        reg_count = (
            session.query(self.Regression)
            .filter(self.Regression.commit_id == commit_id)
            .count()
        )
        if reg_count > 0:
            raise ValueError(
                f"Cannot delete commit {commit_id}: "
                f"{reg_count} Regression(s) reference it; "
                f"clear their commit_id first"
            )

        session.delete(commit)
        session.flush()
```

Also remove the `from sqlalchemy import or_` import if `delete_commit` was its
only consumer. Check: `or_` is also used by `list_commits()` (line 403) and
`list_machines()` (line 549), so the import stays.

### 3c. Drop all FieldChange CRUD methods

Delete the entire "FieldChanges (CRUD only)" section, lines 922-994:
- `create_field_change()` (lines 926-949)
- `get_field_change()` (lines 951-964)
- `list_field_changes()` (lines 966-983)
- `delete_field_change()` (lines 985-994)

### 3d. Rewrite `create_regression()`

Lines 996-1023. The current signature takes `field_change_ids`. The new
signature takes `indicators` (list of dicts) plus optional `notes` and
`commit` parameters.

**Before**:
```python
    def create_regression(
        self,
        session: sqlalchemy.orm.Session,
        title: str,
        field_change_ids: list[int],
        *,
        bug: str | None = None,
        state: int = 0,
    ):
        """Create a Regression with the given FieldChange indicators."""
        _validate_regression_state(state)
        reg = self.Regression()
        reg.uuid = str(uuid_module.uuid4())
        reg.title = title
        reg.bug = bug
        reg.state = state
        session.add(reg)
        session.flush()

        indicators = []
        for fc_id in field_change_ids:
            ri = self.RegressionIndicator()
            ri.regression_id = reg.id
            ri.field_change_id = fc_id
            indicators.append(ri)
        session.add_all(indicators)
        session.flush()
        return reg
```

**After**:
```python
    def create_regression(
        self,
        session: sqlalchemy.orm.Session,
        title: str,
        indicators: list[dict[str, Any]],
        *,
        bug: str | None = None,
        notes: str | None = None,
        commit: Any | None = None,
        state: int = 0,
    ):
        """Create a Regression with the given indicators.

        Each dict in *indicators* must have keys ``machine_id`` (int),
        ``test_id`` (int), and ``metric`` (str).

        *commit* is an optional Commit object whose id is stored on the
        Regression (nullable FK).
        """
        _validate_regression_state(state)
        reg = self.Regression()
        reg.uuid = str(uuid_module.uuid4())
        reg.title = title
        reg.bug = bug
        reg.notes = notes
        reg.state = state
        reg.commit_id = commit.id if commit is not None else None
        session.add(reg)
        session.flush()

        ri_objects = []
        for ind in indicators:
            ri = self.RegressionIndicator()
            ri.uuid = str(uuid_module.uuid4())
            ri.regression_id = reg.id
            ri.machine_id = ind["machine_id"]
            ri.test_id = ind["test_id"]
            ri.metric = ind["metric"]
            ri_objects.append(ri)
        session.add_all(ri_objects)
        session.flush()
        return reg
```

### 3e. Rewrite `update_regression()`

Lines 1040-1058. Add `notes` and `commit` parameters.

**Before**:
```python
    def update_regression(
        self,
        session: sqlalchemy.orm.Session,
        regression,
        *,
        title: str | None = None,
        bug: str | None = None,
        state: int | None = None,
    ):
        """Update mutable fields on a Regression."""
        if title is not None:
            regression.title = title
        if bug is not None:
            regression.bug = bug
        if state is not None:
            _validate_regression_state(state)
            regression.state = state
        session.flush()
        return regression
```

**After**:
```python
    _UNSET = object()

    def update_regression(
        self,
        session: sqlalchemy.orm.Session,
        regression,
        *,
        title: Any = _UNSET,
        bug: Any = _UNSET,
        notes: Any = _UNSET,
        commit: Any = _UNSET,
        state: int | None = None,
    ):
        """Update mutable fields on a Regression.

        For *title*, *bug*, *notes*, and *commit*: pass a value to set,
        ``None`` to clear, or omit (default ``_UNSET``) to leave unchanged.
        *state* uses ``None`` as "leave unchanged" (state cannot be null).
        """
        if title is not self._UNSET:
            regression.title = title
        if bug is not self._UNSET:
            regression.bug = bug
        if notes is not self._UNSET:
            regression.notes = notes
        if commit is not self._UNSET:
            regression.commit_id = commit.id if commit is not None else None
        if state is not None:
            _validate_regression_state(state)
            regression.state = state
        session.flush()
        return regression
```

The `_UNSET` sentinel distinguishes "caller didn't pass the argument" from
"caller explicitly passed ``None`` to clear the field." This is applied
consistently to all nullable string/text fields (`title`, `bug`, `notes`)
and the nullable FK (`commit`). `state` uses `None` as "leave unchanged"
since state is not nullable and can never be cleared.

Note: `_UNSET` is defined as a class attribute on `V5TestSuiteDB` (not a
module-level global) to keep the namespace clean. Place it just before
`update_regression`.

### 3f. Verify `delete_regression()` -- no changes needed

Lines 1073-1081. The cascade on `RegressionIndicator.regression_id` (with
`ondelete="CASCADE"` and SQLAlchemy's `cascade="all, delete-orphan"`) handles
cleanup. No code changes needed here.

### 3g. Rewrite `add_regression_indicator()`

Lines 1084-1100. Replace `field_change` parameter with `machine_id`, `test_id`,
`metric`.

**Before**:
```python
    def add_regression_indicator(
        self,
        session: sqlalchemy.orm.Session,
        regression,
        field_change,
    ):
        """Add a FieldChange as an indicator on a Regression.

        Returns the created RegressionIndicator.  Raises
        ``sqlalchemy.exc.IntegrityError`` if the pair already exists.
        """
        ri = self.RegressionIndicator()
        ri.regression_id = regression.id
        ri.field_change_id = field_change.id
        session.add(ri)
        session.flush()
        return ri
```

**After** (single-indicator method):
```python
    def add_regression_indicator(
        self,
        session: sqlalchemy.orm.Session,
        regression,
        machine_id: int,
        test_id: int,
        metric: str,
    ):
        """Add an indicator to a Regression.

        Returns the created RegressionIndicator.  Raises
        ``sqlalchemy.exc.IntegrityError`` if the (regression, machine,
        test, metric) combination already exists.
        """
        ri = self.RegressionIndicator()
        ri.uuid = str(uuid_module.uuid4())
        ri.regression_id = regression.id
        ri.machine_id = machine_id
        ri.test_id = test_id
        ri.metric = metric
        session.add(ri)
        session.flush()
        return ri
```

**Add batch method** for the API's "silently ignore duplicates" requirement:
```python
    def add_regression_indicators_batch(
        self,
        session: sqlalchemy.orm.Session,
        regression,
        indicators: list[dict[str, Any]],
    ) -> list:
        """Add multiple indicators to a Regression, silently ignoring duplicates.

        Each dict must have keys ``machine_id``, ``test_id``, ``metric``.
        Returns the list of newly created RegressionIndicator objects
        (excludes duplicates that were skipped).

        Note: the check-then-insert pattern has a TOCTOU window under
        concurrent access.  The unique constraint catches this at the DB
        level; the API layer is expected to serialize regression updates.
        """
        created = []
        for ind in indicators:
            existing = (
                session.query(self.RegressionIndicator)
                .filter_by(
                    regression_id=regression.id,
                    machine_id=ind["machine_id"],
                    test_id=ind["test_id"],
                    metric=ind["metric"],
                )
                .first()
            )
            if existing is not None:
                continue
            ri = self.RegressionIndicator()
            ri.uuid = str(uuid_module.uuid4())
            ri.regression_id = regression.id
            ri.machine_id = ind["machine_id"]
            ri.test_id = ind["test_id"]
            ri.metric = ind["metric"]
            session.add(ri)
            created.append(ri)
        session.flush()
        return created
```

### 3h. Rewrite `remove_regression_indicator()`

Lines 1102-1122. Replace `field_change_id` parameter with `machine_id`,
`test_id`, `metric`. Alternatively, accept `indicator_id` or `indicator_uuid`
for simplicity.

Two options:

**Option A** -- lookup by (regression_id, machine_id, test_id, metric):
```python
    def remove_regression_indicator(
        self,
        session: sqlalchemy.orm.Session,
        regression_id: int,
        machine_id: int,
        test_id: int,
        metric: str,
    ) -> bool:
        """Remove a single indicator from a regression.

        Returns True if an indicator was removed, False if none matched.
        """
        count = (
            session.query(self.RegressionIndicator)
            .filter(
                self.RegressionIndicator.regression_id == regression_id,
                self.RegressionIndicator.machine_id == machine_id,
                self.RegressionIndicator.test_id == test_id,
                self.RegressionIndicator.metric == metric,
            )
            .delete()
        )
        if count:
            session.flush()
        return count > 0
```

**Option B** -- lookup by uuid (simpler, mirrors the API pattern where
indicators have their own uuid):
```python
    def remove_regression_indicator(
        self,
        session: sqlalchemy.orm.Session,
        regression_id: int,
        indicator_uuid: str,
    ) -> bool:
        """Remove an indicator from a regression by UUID.

        Returns True if an indicator was removed, False if none matched.
        """
        count = (
            session.query(self.RegressionIndicator)
            .filter(
                self.RegressionIndicator.regression_id == regression_id,
                self.RegressionIndicator.uuid == indicator_uuid,
            )
            .delete()
        )
        if count:
            session.flush()
        return count > 0
```

**Recommendation**: Implement Option B (by uuid). The indicator uuid is the
natural identifier exposed by the API. Also add a `get_regression_indicator()`
method for lookup by uuid:

```python
    def get_regression_indicator(
        self,
        session: sqlalchemy.orm.Session,
        *,
        id: int | None = None,
        uuid: str | None = None,
    ):
        """Fetch a single RegressionIndicator by id or uuid."""
        q = session.query(self.RegressionIndicator)
        if id is not None:
            return q.filter(self.RegressionIndicator.id == id).first()
        if uuid is not None:
            return q.filter(self.RegressionIndicator.uuid == uuid).first()
        raise ValueError("must specify id or uuid")
```


---

## 4. Test changes

### 4a. `tests/server/db/v5/test_models.py`

**Drop FieldChange test class** -- `TestFieldChangeAndRegression` (lines
450-542). This entire class tests FieldChange creation, the unique constraint
on `(regression_id, field_change_id)`, and the regression indicator model
bound to FieldChange. All of this is obsolete.

**Update `TestModelCreation.test_all_tables_created`** (lines 95-104):
Change expected table count from 8 to 7, remove `"t_FieldChange"` from the
expected set:

```python
    def test_all_tables_created(self):
        """All 7 per-suite tables should exist."""
        insp = sqlalchemy.inspect(self.engine)
        tables = set(insp.get_table_names())
        expected = {
            "t_Commit", "t_Machine", "t_Run", "t_Test",
            "t_Sample", "t_Regression",
            "t_RegressionIndicator",
        }
        self.assertTrue(expected.issubset(tables), f"Missing: {expected - tables}")
```

**Add new test class `TestRegressionAndIndicatorModels`** replacing the dropped
class. Tests to include:

1. **Create a Regression with `commit_id` and `notes`**: Create a Commit,
   create a Regression referencing it, verify `commit_id` and `notes` are
   persisted.
2. **Regression `commit_id` nullable**: Create a Regression without a
   `commit_id`, verify it persists with `NULL`.
3. **RegressionIndicator has uuid**: Create an indicator, verify uuid is
   populated.
4. **RegressionIndicator unique constraint on (regression_id, machine_id,
   test_id, metric)**: Insert a duplicate and assert IntegrityError.
5. **RegressionIndicator unique constraint allows same (machine, test, metric)
   on different regressions**: Create two regressions with the same indicator
   triple; should succeed.
6. **Cascading delete: deleting Regression cascades to indicators**: Create a
   regression with indicators, delete regression, verify indicators are gone.
7. **Commit referenced by Regression cannot be deleted**: Create regression
   with `commit_id` set, attempt to delete the commit, expect DB-level FK
   violation (IntegrityError).

### 4b. `tests/server/db/v5/test_crud.py`

**Drop the following test classes entirely:**
- `TestFieldChangeCRUD` (lines 157-255) -- tests FieldChange creation,
  regression creation via `field_change_ids`, all FieldChange-based workflow
- `TestDeleteCommit.test_delete_commit_blocked_by_field_changes` (lines
  310-329) -- tests the FieldChange guard
- `TestDeleteFieldChange` (lines 500-550) -- tests FieldChange deletion
  and cascade to indicators
- `TestRegressionIndicatorManagement` (lines 553-616) -- tests indicator
  add/remove via FieldChange objects

**Update `TestDeleteCommit`:**
- Update class docstring from "blocked by FieldChanges" to "blocked by
  Regressions".
- Keep `test_delete_commit_cascades_to_runs_and_samples` (lines 278-308)
  unchanged.
- Replace `test_delete_commit_blocked_by_field_changes` with
  `test_delete_commit_blocked_by_regression_commit_ref`: Create a regression
  with `commit_id` pointing to a commit. Attempt to delete that commit.
  Assert `ValueError` is raised.
- Keep `test_delete_nonexistent_commit` (lines 332-335) unchanged.

**Update `TestRegressionStateValidation`:**
- `test_all_valid_states_accepted` (lines 637-644) must reflect the new 5
  states (0-4). The test iterates `VALID_REGRESSION_STATES` so it adapts
  automatically, but verify that `create_regression` is called with the new
  indicator-list format (empty list `[]` becomes empty indicator dicts `[]`).
- `test_create_with_invalid_state` (line 622-624) -- update
  `create_regression` call to use new signature:
  `self.tsdb.create_regression(session, "bad state", [], state=99)`
  The `[]` already matches the new format (list of dicts), so no actual
  change needed.
- `test_update_with_invalid_state` (lines 628-634) -- same: update
  `create_regression` call if needed.

**Add new test class `TestRegressionCRUD`** (replacing parts of
`TestFieldChangeCRUD.test_regression_crud`):

```python
class TestRegressionCRUD(_CRUDTestBase):

    def test_create_regression_with_indicators(self):
        """Create a regression with machine/test/metric indicators."""
        session = self.Session()
        machine = self.tsdb.get_or_create_machine(session, "reg-m")
        test = self.tsdb.get_or_create_test(session, "reg-test")
        session.flush()

        reg = self.tsdb.create_regression(
            session, "Perf regression",
            [{"machine_id": machine.id, "test_id": test.id,
              "metric": "execution_time"}],
            bug="BUG-123", state=0)
        session.commit()

        self.assertIsNotNone(reg.uuid)
        self.assertEqual(reg.title, "Perf regression")
        self.assertEqual(reg.bug, "BUG-123")
        self.assertEqual(reg.state, 0)
        self.assertIsNone(reg.notes)
        self.assertIsNone(reg.commit_id)

        # Verify indicator was created
        indicators = (
            session.query(self.tsdb.RegressionIndicator)
            .filter_by(regression_id=reg.id)
            .all()
        )
        self.assertEqual(len(indicators), 1)
        self.assertEqual(indicators[0].machine_id, machine.id)
        self.assertEqual(indicators[0].test_id, test.id)
        self.assertEqual(indicators[0].metric, "execution_time")
        self.assertIsNotNone(indicators[0].uuid)
        session.close()

    def test_create_regression_with_notes_and_commit(self):
        session = self.Session()
        commit = self.tsdb.get_or_create_commit(session, "reg-commit-1")
        session.flush()

        reg = self.tsdb.create_regression(
            session, "Noted regression", [],
            notes="Caused by vectorizer change",
            commit=commit,
            state=1)
        session.commit()

        self.assertEqual(reg.notes, "Caused by vectorizer change")
        self.assertEqual(reg.commit_id, commit.id)
        session.close()

    def test_create_regression_with_empty_indicators(self):
        session = self.Session()
        reg = self.tsdb.create_regression(
            session, "Empty regression", [], state=0)
        session.commit()
        self.assertIsNotNone(reg.id)
        # Verify no indicators were created
        indicators = (
            session.query(self.tsdb.RegressionIndicator)
            .filter_by(regression_id=reg.id)
            .all()
        )
        self.assertEqual(len(indicators), 0)
        session.close()

    def test_update_regression_notes(self):
        session = self.Session()
        reg = self.tsdb.create_regression(
            session, "title", [], state=0)
        session.commit()

        self.tsdb.update_regression(
            session, reg, notes="New notes")
        session.commit()

        fetched = self.tsdb.get_regression(session, id=reg.id)
        self.assertEqual(fetched.notes, "New notes")
        session.close()

    def test_update_regression_commit(self):
        session = self.Session()
        commit = self.tsdb.get_or_create_commit(session, "upd-reg-c")
        reg = self.tsdb.create_regression(
            session, "title", [], state=0)
        session.commit()

        self.tsdb.update_regression(
            session, reg, commit=commit)
        session.commit()
        self.assertEqual(reg.commit_id, commit.id)

        # Clear commit
        self.tsdb.update_regression(
            session, reg, commit=None)
        session.commit()
        self.assertIsNone(reg.commit_id)
        session.close()

    def test_update_regression_state_and_title(self):
        session = self.Session()
        reg = self.tsdb.create_regression(
            session, "original", [], state=0)
        session.commit()

        self.tsdb.update_regression(
            session, reg, title="Updated", state=1)
        session.commit()

        fetched = self.tsdb.get_regression(session, uuid=reg.uuid)
        self.assertEqual(fetched.title, "Updated")
        self.assertEqual(fetched.state, 1)
        session.close()

    def test_delete_regression_cascades_to_indicators(self):
        session = self.Session()
        machine = self.tsdb.get_or_create_machine(session, "del-reg-m")
        test = self.tsdb.get_or_create_test(session, "del-reg-test")
        session.flush()

        reg = self.tsdb.create_regression(
            session, "to delete",
            [{"machine_id": machine.id, "test_id": test.id,
              "metric": "execution_time"}],
            state=0)
        session.commit()
        reg_id = reg.id

        self.tsdb.delete_regression(session, reg_id)
        session.commit()

        self.assertIsNone(self.tsdb.get_regression(session, id=reg_id))
        indicators = (
            session.query(self.tsdb.RegressionIndicator)
            .filter_by(regression_id=reg_id)
            .all()
        )
        self.assertEqual(len(indicators), 0)
        session.close()

    def test_list_regressions_by_state(self):
        session = self.Session()
        self.tsdb.create_regression(
            session, "active-one", [], state=1)
        self.tsdb.create_regression(
            session, "detected-one", [], state=0)
        session.commit()

        active = self.tsdb.list_regressions(session, state=1)
        self.assertGreater(len(active), 0)
        self.assertTrue(
            all(r.state == 1 for r in active))
        session.close()

    def test_update_regression_clear_notes(self):
        """Verify _UNSET pattern allows clearing notes to None."""
        session = self.Session()
        reg = self.tsdb.create_regression(
            session, "title", [], notes="some notes", state=0)
        session.commit()
        self.assertEqual(reg.notes, "some notes")

        self.tsdb.update_regression(session, reg, notes=None)
        session.commit()
        self.assertIsNone(reg.notes)
        session.close()

    def test_update_regression_clear_title(self):
        """Verify _UNSET pattern allows clearing title to None."""
        session = self.Session()
        reg = self.tsdb.create_regression(
            session, "title", [], state=0)
        session.commit()

        self.tsdb.update_regression(session, reg, title=None)
        session.commit()
        self.assertIsNone(reg.title)
        session.close()

    def test_update_regression_clear_bug(self):
        """Verify _UNSET pattern allows clearing bug to None."""
        session = self.Session()
        reg = self.tsdb.create_regression(
            session, "title", [], bug="BUG-1", state=0)
        session.commit()

        self.tsdb.update_regression(session, reg, bug=None)
        session.commit()
        self.assertIsNone(reg.bug)
        session.close()

    def test_old_state_values_rejected(self):
        """States 5 and 6 (old staged/detected_fixed) must be rejected."""
        session = self.Session()
        with self.assertRaises(ValueError):
            self.tsdb.create_regression(
                session, "old state", [], state=5)
        with self.assertRaises(ValueError):
            self.tsdb.create_regression(
                session, "old state", [], state=6)
        session.close()
```

**Add new test class `TestRegressionIndicatorManagement`** (replacing the
dropped class):

```python
class TestRegressionIndicatorManagement(_CRUDTestBase):

    def test_add_regression_indicator(self):
        session = self.Session()
        machine = self.tsdb.get_or_create_machine(session, "ri-add-m")
        test = self.tsdb.get_or_create_test(session, "ri-add-test")
        reg = self.tsdb.create_regression(
            session, "add-ind", [], state=0)
        session.flush()

        ri = self.tsdb.add_regression_indicator(
            session, reg, machine.id, test.id, "execution_time")
        session.commit()

        self.assertIsNotNone(ri.id)
        self.assertIsNotNone(ri.uuid)
        self.assertEqual(ri.machine_id, machine.id)
        self.assertEqual(ri.test_id, test.id)
        self.assertEqual(ri.metric, "execution_time")
        session.close()

    def test_add_duplicate_indicator_rejected(self):
        session = self.Session()
        machine = self.tsdb.get_or_create_machine(session, "ri-dup-m")
        test = self.tsdb.get_or_create_test(session, "ri-dup-test")
        reg = self.tsdb.create_regression(
            session, "dup-ind",
            [{"machine_id": machine.id, "test_id": test.id,
              "metric": "execution_time"}],
            state=0)
        session.commit()

        with self.assertRaises(sqlalchemy.exc.IntegrityError):
            self.tsdb.add_regression_indicator(
                session, reg, machine.id, test.id, "execution_time")
        session.rollback()
        session.close()

    def test_same_triple_on_different_regressions_ok(self):
        session = self.Session()
        machine = self.tsdb.get_or_create_machine(session, "ri-multi-m")
        test = self.tsdb.get_or_create_test(session, "ri-multi-test")
        reg1 = self.tsdb.create_regression(
            session, "reg1", [], state=0)
        reg2 = self.tsdb.create_regression(
            session, "reg2", [], state=0)
        session.flush()

        ri1 = self.tsdb.add_regression_indicator(
            session, reg1, machine.id, test.id, "execution_time")
        ri2 = self.tsdb.add_regression_indicator(
            session, reg2, machine.id, test.id, "execution_time")
        session.commit()

        self.assertIsNotNone(ri1.id)
        self.assertIsNotNone(ri2.id)
        session.close()

    def test_remove_regression_indicator_by_uuid(self):
        session = self.Session()
        machine = self.tsdb.get_or_create_machine(session, "ri-rem-m")
        test = self.tsdb.get_or_create_test(session, "ri-rem-test")
        reg = self.tsdb.create_regression(
            session, "rem-ind",
            [{"machine_id": machine.id, "test_id": test.id,
              "metric": "execution_time"}],
            state=0)
        session.commit()

        indicator = (
            session.query(self.tsdb.RegressionIndicator)
            .filter_by(regression_id=reg.id)
            .first()
        )
        removed = self.tsdb.remove_regression_indicator(
            session, reg.id, indicator.uuid)
        session.commit()
        self.assertTrue(removed)

        remaining = (
            session.query(self.tsdb.RegressionIndicator)
            .filter_by(regression_id=reg.id)
            .all()
        )
        self.assertEqual(len(remaining), 0)
        session.close()

    def test_remove_nonexistent_indicator(self):
        session = self.Session()
        removed = self.tsdb.remove_regression_indicator(
            session, 999, "nonexistent-uuid")
        self.assertFalse(removed)
        session.close()

    def test_remove_indicator_wrong_regression(self):
        """Indicator exists but belongs to a different regression."""
        session = self.Session()
        machine = self.tsdb.get_or_create_machine(session, "ri-wrong-m")
        test = self.tsdb.get_or_create_test(session, "ri-wrong-test")
        reg1 = self.tsdb.create_regression(
            session, "reg1",
            [{"machine_id": machine.id, "test_id": test.id,
              "metric": "execution_time"}],
            state=0)
        reg2 = self.tsdb.create_regression(
            session, "reg2", [], state=0)
        session.commit()

        indicator = (
            session.query(self.tsdb.RegressionIndicator)
            .filter_by(regression_id=reg1.id)
            .first()
        )
        # Try to remove reg1's indicator using reg2's id
        removed = self.tsdb.remove_regression_indicator(
            session, reg2.id, indicator.uuid)
        self.assertFalse(removed)
        session.close()

    def test_get_regression_indicator_by_uuid(self):
        session = self.Session()
        machine = self.tsdb.get_or_create_machine(session, "ri-get-m")
        test = self.tsdb.get_or_create_test(session, "ri-get-test")
        reg = self.tsdb.create_regression(
            session, "get-ind",
            [{"machine_id": machine.id, "test_id": test.id,
              "metric": "execution_time"}],
            state=0)
        session.commit()

        indicator = (
            session.query(self.tsdb.RegressionIndicator)
            .filter_by(regression_id=reg.id)
            .first()
        )
        fetched = self.tsdb.get_regression_indicator(
            session, uuid=indicator.uuid)
        self.assertEqual(fetched.id, indicator.id)
        session.close()

    def test_get_regression_indicator_requires_id_or_uuid(self):
        session = self.Session()
        with self.assertRaises(ValueError):
            self.tsdb.get_regression_indicator(session)
        session.close()

    def test_batch_add_indicators_silently_ignores_duplicates(self):
        session = self.Session()
        machine = self.tsdb.get_or_create_machine(session, "ri-batch-m")
        test = self.tsdb.get_or_create_test(session, "ri-batch-test")
        reg = self.tsdb.create_regression(
            session, "batch",
            [{"machine_id": machine.id, "test_id": test.id,
              "metric": "execution_time"}],
            state=0)
        session.commit()

        # Batch add: one duplicate, one new
        test2 = self.tsdb.get_or_create_test(session, "ri-batch-test2")
        session.flush()
        created = self.tsdb.add_regression_indicators_batch(
            session, reg,
            [
                {"machine_id": machine.id, "test_id": test.id,
                 "metric": "execution_time"},  # duplicate
                {"machine_id": machine.id, "test_id": test2.id,
                 "metric": "execution_time"},  # new
            ])
        session.commit()

        self.assertEqual(len(created), 1)
        self.assertEqual(created[0].test_id, test2.id)
        session.close()
```


---

## 5. Schema parsing changes

File: `lnt/server/db/v5/schema.py`

**No changes needed.** FieldChange is not referenced anywhere in the schema
parser. The parser deals with `metrics`, `commit_fields`, and
`machine_fields` -- all of which remain unchanged.


---

## 6. Verification steps

After implementing all changes:

1. **Run the v5 DB model tests:**
   ```
   lit -sv tests/server/db/v5/test_models.py
   ```
   Verify all existing tests pass and new tests pass. The table creation
   test should show 7 tables instead of 8.

2. **Run the v5 DB CRUD tests:**
   ```
   lit -sv tests/server/db/v5/test_crud.py
   ```
   Verify all regression-related tests pass with new signatures.

3. **Run the full v5 test suite:**
   ```
   lit -sv tests/server/db/v5/
   ```

4. **Run broader cross-cutting tests** to catch any references to the old
   model that were missed:
   ```
   lit -sv tests/
   ```

5. **Grep for stale references** to ensure nothing was missed in the DB layer:
   ```
   grep -rn 'FieldChange\|field_change' lnt/server/db/v5/
   ```
   This should return zero results after the changes.

6. **Verify mypy** (if type checking is configured):
   ```
   tox -e mypy
   ```

Note: Steps 4-6 may surface breakages in the API layer
(`lnt/server/api/v5/endpoints/regressions.py`,
`lnt/server/api/v5/endpoints/field_changes.py`, etc.) and other test files
that reference the old FieldChange-based model. Those are expected and will
be addressed in a separate API-layer plan.
