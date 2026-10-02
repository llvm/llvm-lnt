"""The profile endpoints (endpoints.md, Profiles).

Driven over the real application and a real database, with profiles submitted the way a client
submits them (D12). What is interesting here is mostly what the endpoints serve -- raw counts, a
function's counters derived from its instructions, an order the client can rely on -- and what they
refuse to do: the listing never touches the stored blob (D5).
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any
from urllib.parse import quote
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text

from conftest import code_of, encoded_profile, run_payload
from lnt_v5 import profile_format
from lnt_v5.routes.profiles import PROFILES_PATH, RUN_PROFILES_PATH
from lnt_v5.routes.runs import RUNS_PATH
from lnt_v5.routes.suites import SUITES_PATH
from lnt_v5.scopes import Scope
from lnt_v5.suites.tables import SuiteTables


def ret(address: int, **counters: float) -> dict[str, Any]:
    return {"address": address, "counters": counters, "text": "ret"}


# The counters are chosen so the two orderings differ: `main` is the hottest by the sum endpoints.md
# sorts on, while `hot` is the hottest by `cycles` alone. `tie_a` and `tie_b` have the same sum and
# are listed in the order that is not the tiebreaker's, so the tiebreaker has something to do.
PROFILE = encoded_profile(
    {
        "disassembly_format": "llvm-objdump",
        "counters": {"cycles": 1234567, "branch-misses": 890},
        "functions": [
            {
                "name": "main",
                "instructions": [
                    {
                        "address": 0x1000,
                        "counters": {"cycles": 30, "branch-misses": 40},
                        "text": "push rbp",
                    },
                    ret(0x1004, cycles=20, **{"branch-misses": 20}),
                ],
            },
            {"name": "hot", "instructions": [ret(0x2000, cycles=100, **{"branch-misses": 5})]},
            {"name": "tie_b", "instructions": [ret(0x3000, cycles=10)]},
            {"name": "tie_a", "instructions": [ret(0x4000, cycles=10)]},
            {"name": "cold", "instructions": []},
        ],
    }
)

# A demangled `operator/` overload, which is why a function is named in a query parameter rather
# than in the path (R1): v4's importer runs `objdump -C`, so what is stored is demangled.
SLASHED = "std::operator/(std::filesystem::path const&, std::filesystem::path const&)"
# Spaces, angle brackets, an ampersand and a comma, all of which a query string has to escape.
PUNCTUATED = "Matrix<double, 3>::operator*(Matrix<double, 3> const&) &"
# What a symbol looks like when the producer did not demangle.
MANGLED = "_ZNSt3__16vectorIiNS_9allocatorIiEEE9push_backERKi"
# A `+`, which an unescaped query string reads as a space.
PLUS = "Big::operator+(Big const&) const"
# Dot segments, which a URL path would normalize away.
DOTTED = "a/../b/./c"
# A trailing `/`, which R1's redirect would strip from a path.
TRAILING = "std::operator/"
EXOTIC_CYCLES = {SLASHED: 3.0, PUNCTUATED: 2.0, MANGLED: 1.0, PLUS: 4.0, DOTTED: 5.0, TRAILING: 6.0}

# Six function names that would not survive being a path segment, each with one `ret` in it.
EXOTIC = encoded_profile(
    {
        "disassembly_format": "llvm-objdump",
        "counters": {"cycles": 42},
        "functions": [
            {"name": name, "instructions": [ret(0x1000, cycles=cycles)]}
            for name, cycles in EXOTIC_CYCLES.items()
        ],
    }
)

NTS: dict[str, Any] = {"name": "nts", "metrics": [{"name": "execution_time", "type": "real"}]}

RUNS = RUNS_PATH.format(testsuite="nts")
PROFILES = PROFILES_PATH.format(testsuite="nts")


def run_profiles(run: str) -> str:
    return RUN_PROFILES_PATH.format(testsuite="nts", uuid=run)


def disassembly(uuid: str) -> str:
    return f"{PROFILES}/{uuid}/disassembly"


@pytest.fixture
def suite(make_api_suite: Callable[[dict[str, Any]], SuiteTables]) -> SuiteTables:
    return make_api_suite(NTS)


@pytest.fixture
def submit(
    api_client: TestClient, submitter: dict[str, str], suite: SuiteTables
) -> Callable[..., str]:
    """Submit a run whose test entries are `(test name, encoded profile or None)`, and name it."""

    def post(*tests: tuple[str, str | None]) -> str:
        entries = [{"name": name, "profile": profile} for name, profile in tests]
        response = api_client.post(RUNS, json=run_payload(tests=entries), headers=submitter)
        assert response.status_code == 201, response.text
        return str(response.json()["uuid"])

    return post


@pytest.fixture
def stored(api_client: TestClient, submit: Callable[..., str]) -> Callable[..., str]:
    """Store one profile and hand back its UUID.

    Through the listing, which is the bridge endpoints.md gives a client that knows a run and a
    test name and needs a UUID -- and which has tests of its own below.
    """

    def store(encoded: str = PROFILE) -> str:
        run = submit(("bench", encoded))
        listed = api_client.get(run_profiles(run))
        assert listed.status_code == 200, listed.text
        return str(listed.json()["items"][0]["uuid"])

    return store


class TestRunListing:
    """`GET /runs/{uuid}/profiles`: the bridge from run+test coordinates to UUIDs."""

    def test_carries_the_test_name_and_the_uuid_in_r2s_unpaginated_envelope(
        self, api_client: TestClient, submit: Callable[..., str]
    ) -> None:
        run = submit(("bench", PROFILE))

        body = api_client.get(run_profiles(run)).json()

        assert list(body) == ["items"]
        assert [item["test"] for item in body["items"]] == ["bench"]
        assert len(body["items"]) == 1

    def test_is_ordered_by_test_name(
        self, api_client: TestClient, submit: Callable[..., str]
    ) -> None:
        # endpoints.md: the client renders this straight into a dropdown, and the list is bounded
        # by the tests of one run, so unlike `GET /runs/{uuid}/samples` it can afford the sort.
        run = submit(("zeta", PROFILE), ("alpha", PROFILE), ("middle", PROFILE))

        items = api_client.get(run_profiles(run)).json()["items"]

        assert [item["test"] for item in items] == ["alpha", "middle", "zeta"]

    def test_lists_only_the_tests_that_carry_a_profile(
        self, api_client: TestClient, submit: Callable[..., str]
    ) -> None:
        run = submit(("with", PROFILE), ("without", None))

        items = api_client.get(run_profiles(run)).json()["items"]

        assert [item["test"] for item in items] == ["with"]

    def test_a_run_with_no_profiles_is_an_empty_envelope(
        self, api_client: TestClient, submit: Callable[..., str]
    ) -> None:
        # An ordinary answer rather than a 404: the run exists and carries nothing.
        run = submit(("bench", None))

        response = api_client.get(run_profiles(run))

        assert response.status_code == 200
        assert response.json() == {"items": []}

    def test_serves_only_this_runs_profiles(
        self, api_client: TestClient, submit: Callable[..., str]
    ) -> None:
        mine = submit(("mine", PROFILE))
        submit(("theirs", PROFILE))

        items = api_client.get(run_profiles(mine)).json()["items"]

        assert [item["test"] for item in items] == ["mine"]

    def test_the_uuid_addresses_the_profile_data_endpoints(
        self, api_client: TestClient, submit: Callable[..., str]
    ) -> None:
        run = submit(("bench", PROFILE))

        uuid = api_client.get(run_profiles(run)).json()["items"][0]["uuid"]

        assert api_client.get(f"{PROFILES}/{uuid}").json()["run_uuid"] == run

    def test_accepts_the_run_uuid_in_either_case(
        self, api_client: TestClient, submit: Callable[..., str]
    ) -> None:
        run = submit(("bench", PROFILE))

        upper = api_client.get(run_profiles(run.upper()))

        assert upper.json() == api_client.get(run_profiles(run)).json()

    def test_is_404_for_a_run_that_is_not_there(
        self, api_client: TestClient, suite: SuiteTables
    ) -> None:
        response = api_client.get(run_profiles(str(uuid4())))

        assert response.status_code == 404
        assert code_of(response) == "not_found"

    def test_is_404_for_a_suite_that_is_not_there(self, api_client: TestClient) -> None:
        response = api_client.get(f"{SUITES_PATH}/nope/runs/{uuid4()}/profiles")

        assert response.status_code == 404
        assert code_of(response) == "not_found"


class TestMetadata:
    """`GET /profiles/{uuid}`: what the profile is of, and its top-level counters."""

    @pytest.fixture
    def metadata(self, stored: Callable[..., str]) -> str:
        return stored()

    def test_carries_exactly_the_keys_endpoints_md_gives_it(
        self, api_client: TestClient, metadata: str
    ) -> None:
        response = api_client.get(f"{PROFILES}/{metadata}")

        assert response.status_code == 200
        assert set(response.json()) == {
            "uuid",
            "test",
            "run_uuid",
            "counters",
            "disassembly_format",
        }

    def test_names_the_profile_the_test_and_the_run(
        self, api_client: TestClient, submit: Callable[..., str]
    ) -> None:
        run = submit(("bench", PROFILE))
        uuid = api_client.get(run_profiles(run)).json()["items"][0]["uuid"]

        body = api_client.get(f"{PROFILES}/{uuid}").json()

        assert (body["uuid"], body["test"], body["run_uuid"]) == (uuid, "bench", run)

    def test_the_top_level_counters_are_raw_integers(
        self, api_client: TestClient, metadata: str
    ) -> None:
        # endpoints.md: the top-level counters are the one integer-valued counters in a profile,
        # and they are raw totals rather than a share of anything.
        counters = api_client.get(f"{PROFILES}/{metadata}").json()["counters"]

        assert counters == {"cycles": 1234567, "branch-misses": 890}
        assert all(isinstance(value, int) for value in counters.values())

    def test_reports_the_disassembly_format(self, api_client: TestClient, metadata: str) -> None:
        body = api_client.get(f"{PROFILES}/{metadata}").json()

        assert body["disassembly_format"] == "llvm-objdump"

    def test_accepts_the_profile_uuid_in_either_case(
        self, api_client: TestClient, metadata: str
    ) -> None:
        upper = api_client.get(f"{PROFILES}/{metadata.upper()}")

        assert upper.json() == api_client.get(f"{PROFILES}/{metadata}").json()


class TestFunctionList:
    """`GET /profiles/{uuid}/functions`: every function, hottest first."""

    @pytest.fixture
    def listed(self, api_client: TestClient, stored: Callable[..., str]) -> dict[str, Any]:
        body: dict[str, Any] = api_client.get(f"{PROFILES}/{stored()}/functions").json()
        return body

    def test_is_r2s_unpaginated_envelope_over_name_counters_and_length(
        self, listed: dict[str, Any]
    ) -> None:
        assert list(listed) == ["items"]
        assert all(set(item) == {"name", "counters", "length"} for item in listed["items"])

    def test_covers_every_function_the_profile_holds(self, listed: dict[str, Any]) -> None:
        assert {item["name"] for item in listed["items"]} == {
            "main",
            "hot",
            "tie_a",
            "tie_b",
            "cold",
        }

    def test_is_sorted_by_the_sum_of_a_functions_counters_descending(
        self, listed: dict[str, Any]
    ) -> None:
        # endpoints.md: hottest first, where "hottest" is the sum across counters -- a default
        # ordering rather than a physical quantity. `hot` has the larger `cycles` of the two and
        # still comes second, which is exactly the case the client's own counter dropdown re-sorts.
        assert [item["name"] for item in listed["items"]][:2] == ["main", "hot"]

    def test_breaks_a_tie_by_name_ascending(self, listed: dict[str, Any]) -> None:
        # Two functions with the same sum, so without the tiebreaker the order would be whatever
        # the blob happened to list. endpoints.md makes it total.
        names = [item["name"] for item in listed["items"]]

        assert names == ["main", "hot", "tie_a", "tie_b", "cold"]

    def test_the_counters_are_the_raw_aggregate_rather_than_a_percentage(
        self, listed: dict[str, Any]
    ) -> None:
        # The v4 proof of concept called these percentages; endpoints.md is emphatic that every
        # counter the API serves is raw and the client computes shares from it.
        functions = {item["name"]: item["counters"] for item in listed["items"]}

        assert functions["hot"] == {"cycles": 100.0, "branch-misses": 5.0}

    def test_a_function_carries_only_the_counters_it_was_measured_with(
        self, listed: dict[str, Any]
    ) -> None:
        functions = {item["name"]: item["counters"] for item in listed["items"]}

        assert functions["tie_a"] == {"cycles": 10.0}

    def test_the_length_is_the_instruction_count(self, listed: dict[str, Any]) -> None:
        lengths = {item["name"]: item["length"] for item in listed["items"]}

        assert lengths == {"main": 2, "hot": 1, "tie_a": 1, "tie_b": 1, "cold": 0}


class TestDisassembly:
    """`GET /profiles/{uuid}/disassembly?function=`: the one endpoint that decompresses."""

    @pytest.fixture
    def main(self, api_client: TestClient, stored: Callable[..., str]) -> dict[str, Any]:
        response = api_client.get(disassembly(stored()), params={"function": "main"})
        body: dict[str, Any] = response.json()
        return body

    def test_carries_exactly_the_keys_endpoints_md_gives_it(self, main: dict[str, Any]) -> None:
        assert set(main) == {"name", "counters", "disassembly_format", "instructions"}

    def test_repeats_the_functions_aggregate_counters(self, main: dict[str, Any]) -> None:
        assert main["name"] == "main"
        assert main["counters"] == {"cycles": 50.0, "branch-misses": 60.0}
        assert main["disassembly_format"] == "llvm-objdump"

    def test_serves_every_instruction_with_its_address_counters_and_text(
        self, main: dict[str, Any]
    ) -> None:
        # Addresses are stored as deltas from the previous one, so a wrong reading of the second
        # would be a wrong address rather than a failure. Counters are raw, as everywhere else.
        assert main["instructions"] == [
            {
                "address": 0x1000,
                "counters": {"cycles": 30.0, "branch-misses": 40.0},
                "text": "push rbp",
            },
            {
                "address": 0x1004,
                "counters": {"cycles": 20.0, "branch-misses": 20.0},
                "text": "ret",
            },
        ]

    def test_an_address_is_an_integer(self, main: dict[str, Any]) -> None:
        assert all(isinstance(one["address"], int) for one in main["instructions"])

    def test_a_function_with_no_instructions_is_an_empty_list(
        self, api_client: TestClient, stored: Callable[..., str]
    ) -> None:
        response = api_client.get(disassembly(stored()), params={"function": "cold"})

        assert response.status_code == 200
        assert response.json()["instructions"] == []

    def test_is_404_for_a_function_the_profile_does_not_hold(
        self, api_client: TestClient, stored: Callable[..., str]
    ) -> None:
        response = api_client.get(disassembly(stored()), params={"function": "nosuchfunction"})

        assert response.status_code == 404
        assert code_of(response) == "not_found"

    def test_is_404_for_an_empty_function_name(
        self, api_client: TestClient, stored: Callable[..., str]
    ) -> None:
        # No function can have one (D12), so it names nothing rather than being malformed.
        response = api_client.get(disassembly(stored()), params={"function": ""})

        assert response.status_code == 404
        assert code_of(response) == "not_found"

    def test_parses_the_blob_once_per_request(
        self, api_client: TestClient, stored: Callable[..., str], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # A parse is not cached between requests, deliberately, so the one thing worth pinning is
        # that a single request does not pay for it twice -- the aggregate counters this response
        # repeats come from the profile already parsed for the disassembly.
        uuid = stored()
        parses = 0
        real = profile_format.read_profile

        def counting(data: bytes) -> profile_format.Profile:
            nonlocal parses
            parses += 1
            return real(data)

        monkeypatch.setattr(profile_format, "read_profile", counting)

        assert api_client.get(disassembly(uuid), params={"function": "main"}).status_code == 200
        assert parses == 1


class TestFunctionNames:
    """R1: a function is named in a query parameter, so any name the profile holds is reachable."""

    @pytest.fixture
    def exotic(self, stored: Callable[..., str]) -> str:
        return stored(EXOTIC)

    def test_the_function_list_serves_every_name_verbatim(
        self, api_client: TestClient, exotic: str
    ) -> None:
        items = api_client.get(f"{PROFILES}/{exotic}/functions").json()["items"]

        assert {item["name"] for item in items} == set(EXOTIC_CYCLES)

    @pytest.mark.parametrize("name", list(EXOTIC_CYCLES))
    def test_every_name_the_list_serves_addresses_its_function(
        self, api_client: TestClient, exotic: str, name: str
    ) -> None:
        # `params` encodes the name the way any HTTP client does, which is all a caller has to do:
        # nothing in a query value is special to the router, `/` and dot segments included.
        response = api_client.get(disassembly(exotic), params={"function": name})

        assert response.status_code == 200
        assert response.json()["name"] == name
        assert response.json()["counters"] == {"cycles": EXOTIC_CYCLES[name]}

    def test_a_plus_must_be_encoded_like_in_any_query_string(
        self, api_client: TestClient, exotic: str
    ) -> None:
        # Everything escaped but the `+`, which a query string decodes as a space, so this asks for
        # a function that is not there. Not something the endpoint chooses: it is how query strings
        # are decoded, and any HTTP client's own encoding escapes it.
        response = api_client.get(f"{disassembly(exotic)}?function={quote(PLUS, safe='+')}")

        assert response.status_code == 404

    def test_the_function_is_required(self, api_client: TestClient, exotic: str) -> None:
        response = api_client.get(disassembly(exotic))

        assert response.status_code == 400
        assert code_of(response) == "invalid_request"


# The three endpoints that address a profile by its UUID, as the suffix each adds to it. Several
# things below hold for all three and are asserted once over this list rather than once per class.
PROFILE_DATA = ["", "/functions", "/disassembly?function=main"]


class TestAddressingSomethingThatIsNotThere:
    """The 404s the three profile data endpoints share (R1, endpoints.md).

    One class over all three rather than a copy in each, so that a fourth data endpoint inherits
    the coverage instead of quietly going without it.
    """

    @pytest.mark.parametrize("suffix", PROFILE_DATA)
    def test_a_profile_uuid_no_profile_has_is_404(
        self, api_client: TestClient, suite: SuiteTables, suffix: str
    ) -> None:
        response = api_client.get(f"{PROFILES}/{uuid4()}{suffix}")

        assert response.status_code == 404
        assert code_of(response) == "not_found"

    @pytest.mark.parametrize("suffix", PROFILE_DATA)
    def test_a_segment_that_is_not_a_uuid_is_404(
        self, api_client: TestClient, suite: SuiteTables, suffix: str
    ) -> None:
        # endpoints.md: no profile has that UUID, so it is the same 404 rather than a 400.
        response = api_client.get(f"{PROFILES}/not-a-uuid{suffix}")

        assert response.status_code == 404
        assert code_of(response) == "not_found"

    @pytest.mark.parametrize("suffix", PROFILE_DATA)
    def test_a_suite_that_does_not_exist_is_404(self, api_client: TestClient, suffix: str) -> None:
        # Before the profile is looked for at all: R1 scopes every one of these to a suite.
        response = api_client.get(f"{SUITES_PATH}/nope/profiles/{uuid4()}{suffix}")

        assert response.status_code == 404
        assert code_of(response) == "not_found"


class TestTheBlobStaysOutOfTheListing:
    """D5 and D12: `data` is excluded from the default result set and loaded only when needed.

    Core selects the columns it is asked for, so the rule is a property of each query rather than
    of the table, and the check has to be one too. Renaming the column out from under the server is
    the strongest form of it available: a query that names `data` cannot run at all afterwards, and
    one that does not is untouched.
    """

    @pytest.fixture
    def without_the_column(self, db_engine: Engine) -> Callable[[], None]:
        def rename() -> None:
            with db_engine.begin() as connection:
                connection.execute(text("ALTER TABLE nts.profile RENAME COLUMN data TO hidden"))

        return rename

    def test_the_listing_does_not_touch_the_blob(
        self,
        api_client: TestClient,
        submit: Callable[..., str],
        without_the_column: Callable[[], None],
    ) -> None:
        run = submit(("bench", PROFILE))
        without_the_column()

        response = api_client.get(run_profiles(run))

        assert response.status_code == 200
        assert [item["test"] for item in response.json()["items"]] == ["bench"]

    @pytest.mark.parametrize("suffix", PROFILE_DATA)
    def test_the_data_endpoints_do(
        self,
        api_client: TestClient,
        stored: Callable[..., str],
        without_the_column: Callable[[], None],
        suffix: str,
    ) -> None:
        # The other half of the check: without this the test above would pass just as well against
        # an endpoint that had stopped working. A column the server expects and cannot find is D2's
        # stale reader, so the 409 is the schema-changed answer rather than a fault.
        uuid = stored()
        without_the_column()

        response = api_client.get(f"{PROFILES}/{uuid}{suffix}")

        assert response.status_code == 409
        assert code_of(response) == "conflict"


class TestAuthorization:
    """R5: `read` on all four, which every valid key grants and anonymous access satisfies."""

    @pytest.fixture
    def paths(self, api_client: TestClient, submit: Callable[..., str]) -> list[str]:
        run = submit(("bench", PROFILE))
        uuid = api_client.get(run_profiles(run)).json()["items"][0]["uuid"]
        return [
            run_profiles(run),
            f"{PROFILES}/{uuid}",
            f"{PROFILES}/{uuid}/functions",
            f"{PROFILES}/{uuid}/disassembly?function=main",
        ]

    def test_needs_no_credential(self, api_client: TestClient, paths: list[str]) -> None:
        assert [api_client.get(path).status_code for path in paths] == [200] * 4

    def test_a_read_key_is_enough(
        self,
        api_client: TestClient,
        paths: list[str],
        make_key: Callable[..., str],
        bearer: Callable[[str], dict[str, str]],
    ) -> None:
        headers = bearer(make_key(Scope.READ))

        assert [api_client.get(path, headers=headers).status_code for path in paths] == [200] * 4

    def test_an_unknown_token_is_401_even_though_read_allows_anonymous_access(
        self, api_client: TestClient, paths: list[str], bearer: Callable[[str], dict[str, str]]
    ) -> None:
        # R5: a bad credential is never silently downgraded to anonymous access.
        headers = bearer("0" * 64)

        assert [api_client.get(path, headers=headers).status_code for path in paths] == [401] * 4
