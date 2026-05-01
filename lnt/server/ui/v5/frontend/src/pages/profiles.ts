// pages/profiles.ts — Profiles page: A/B hardware counter profile viewer.

import type { PageModule, RouteParams } from '../router';
import type {
  ProfileListItem, ProfileMetadata, ProfileFunctionInfo,
  ProfileFunctionDetail, RunInfo, CommitSummary,
} from '../types';
import {
  getRun, getRuns, getCommits, getProfilesForRun,
  getProfileMetadata, getProfileFunctions, getProfileFunctionDetail,
  getTestSuiteInfoCached,
} from '../api';
import { getTestsuites } from '../router';
import { el, matchesFilter, updateFilterValidation, commitDisplayValue } from '../utils';
import { renderMachineCombobox } from '../components/machine-combobox';
import { createCommitPicker } from '../components/commit-combobox';
import { renderProfileStats } from '../components/profile-stats';
import { renderProfileViewer, type DisplayMode } from '../components/profile-viewer';
import { heatGradient } from '../components/profile-colors';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let controller: AbortController | null = null;

const commitFieldsCache = new Map<string, Array<{ name: string; display?: boolean }>>();

// Per-side cascading selector containers (avoids hacky DOM property injection)
interface CascadeRefs { runContainer: HTMLElement; testContainer: HTMLElement }
const cascadeRefs = new Map<'a' | 'b', CascadeRefs>();

// Shared state
let selectedCounter = '';
let displayMode: DisplayMode = 'relative';

// Cleanup handles
let machineComboA: ReturnType<typeof renderMachineCombobox> | null = null;
let machineComboB: ReturnType<typeof renderMachineCombobox> | null = null;
let commitPickerA: ReturnType<typeof createCommitPicker> | null = null;
let commitPickerB: ReturnType<typeof createCommitPicker> | null = null;
let statsHandle: { destroy: () => void } | null = null;
let viewerHandleA: { destroy: () => void; isShowAll: () => boolean } | null = null;
let viewerHandleB: { destroy: () => void; isShowAll: () => boolean } | null = null;
let machineCommitsAbortA: AbortController | null = null;
let machineCommitsAbortB: AbortController | null = null;

interface SideState {
  suite: string;
  machine: string;
  commit: string;
  runUuid: string;
  testName: string;
  profileUuid: string;
  metadata: ProfileMetadata | null;
  functions: ProfileFunctionInfo[];
  selectedFunction: string;
  functionDetail: ProfileFunctionDetail | null;
  machineCommits: CommitSummary[] | null;
  machineCommitsLoading: boolean;
  profiles: ProfileListItem[];  // cached profiles for the selected run
  runs: RunInfo[];  // cached runs for machine+commit
}

function initialSideState(): SideState {
  return {
    suite: '', machine: '', commit: '', runUuid: '', testName: '', profileUuid: '',
    metadata: null, functions: [], selectedFunction: '',
    functionDetail: null, machineCommits: null, machineCommitsLoading: false,
    profiles: [], runs: [],
  };
}

let sideA: SideState = initialSideState();
let sideB: SideState = initialSideState();

// DOM references
let sideAContainer: HTMLElement | null = null;
let sideBContainer: HTMLElement | null = null;
let statsContainer: HTMLElement | null = null;
let controlsContainer: HTMLElement | null = null;
let fnSelectorAContainer: HTMLElement | null = null;
let fnSelectorBContainer: HTMLElement | null = null;
let viewerAContainer: HTMLElement | null = null;
let viewerBContainer: HTMLElement | null = null;
let counterSelect: HTMLSelectElement | null = null;
let displayModeSelect: HTMLSelectElement | null = null;

// ---------------------------------------------------------------------------
// Page module
// ---------------------------------------------------------------------------

export const profilesPage: PageModule = {
  mount(container: HTMLElement, _params: RouteParams): void {
    cleanup();
    controller = new AbortController();

    container.append(el('h2', { class: 'page-header' }, 'Profiles'));

    // Read URL params
    const urlParams = new URLSearchParams(window.location.search);
    const urlSuiteA = urlParams.get('suite_a') || '';
    const urlSuiteB = urlParams.get('suite_b') || '';
    const urlRunA = urlParams.get('run_a') || '';
    const urlTestA = urlParams.get('test_a') || '';
    const urlRunB = urlParams.get('run_b') || '';
    const urlTestB = urlParams.get('test_b') || '';

    // A/B Picker (suite selector is per-side, inside each picker)
    const pickerRow = el('div', { class: 'profile-picker' });
    sideAContainer = el('div', { class: 'profile-side' });
    sideAContainer.append(el('h3', {}, 'Side A'));
    sideBContainer = el('div', { class: 'profile-side' });
    sideBContainer.append(el('h3', {}, 'Side B'));
    pickerRow.append(sideAContainer, sideBContainer);
    container.append(pickerRow);

    // Stats bar
    statsContainer = el('div', { class: 'profile-stats-container' });
    container.append(statsContainer);

    // Global controls (counter + display mode)
    controlsContainer = el('div', { class: 'profile-viewer-controls' });
    container.append(controlsContainer);

    // Function selectors + viewers
    const columnsRow = el('div', { class: 'profile-columns' });
    const colA = el('div', { class: 'profile-column' });
    fnSelectorAContainer = el('div', { class: 'profile-fn-selector' });
    viewerAContainer = el('div', { class: 'profile-viewer-container' });
    colA.append(fnSelectorAContainer, viewerAContainer);

    const colB = el('div', { class: 'profile-column' });
    fnSelectorBContainer = el('div', { class: 'profile-fn-selector' });
    viewerBContainer = el('div', { class: 'profile-viewer-container' });
    colB.append(fnSelectorBContainer, viewerBContainer);

    columnsRow.append(colA, colB);
    container.append(columnsRow);

    // Set initial suite from URL and render
    sideA.suite = urlSuiteA;
    sideB.suite = urlSuiteB;

    // Pre-fetch commit_fields for URL-restored suites
    for (const suite of [urlSuiteA, urlSuiteB]) {
      if (suite && !commitFieldsCache.has(suite)) {
        getTestSuiteInfoCached(suite)
          .then(info => { commitFieldsCache.set(suite, info.schema.commit_fields); })
          .catch(() => {});
      }
    }

    // Render immediately; commits are loaded on-demand when a machine is
    // selected (via loadMachineCommits).
    renderSidePickers();
    if (urlRunA || urlRunB) {
      restoreFromUrl(urlRunA, urlTestA, urlRunB, urlTestB);
    }
  },

  unmount(): void {
    cleanup();
  },
};

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function loadMachineCommits(side: 'a' | 'b', suite: string, machine: string): Promise<void> {
  const state = side === 'a' ? sideA : sideB;
  state.machineCommitsLoading = true;

  // Abort previous for this side
  const prevCtrl = side === 'a' ? machineCommitsAbortA : machineCommitsAbortB;
  if (prevCtrl) prevCtrl.abort();
  const ctrl = new AbortController();
  if (side === 'a') machineCommitsAbortA = ctrl;
  else machineCommitsAbortB = ctrl;

  try {
    const commits = await getCommits(suite, {
      machine,
      has_profiles: true,
      signal: ctrl.signal,
    });
    state.machineCommits = commits;
    state.machineCommitsLoading = false;
  } catch (e: unknown) {
    if (isAbort(e)) return;
    state.machineCommits = null;
    state.machineCommitsLoading = false;
  }
}

async function loadRuns(side: 'a' | 'b'): Promise<void> {
  const state = side === 'a' ? sideA : sideB;
  if (!state.suite || !state.machine || !state.commit) return;

  try {
    state.runs = await getRuns(
      state.suite,
      { machine: state.machine, commit: state.commit, has_profiles: true },
      controller?.signal,
    );
    renderRunSelect(side);
  } catch (e: unknown) {
    if (isAbort(e)) return;
    state.runs = [];
    renderRunSelect(side);
  }
}

async function loadProfiles(side: 'a' | 'b'): Promise<void> {
  const state = side === 'a' ? sideA : sideB;
  if (!state.suite || !state.runUuid) return;

  try {
    const profiles = await getProfilesForRun(state.suite, state.runUuid, controller?.signal);
    state.profiles = profiles;
    renderTestSelect(side);
  } catch (e: unknown) {
    if (isAbort(e)) return;
    state.profiles = [];
    renderTestSelect(side);
  }
}

async function loadProfile(side: 'a' | 'b'): Promise<void> {
  const state = side === 'a' ? sideA : sideB;
  if (!state.suite || !state.profileUuid) return;

  const requestedUuid = state.profileUuid;
  const container = side === 'a' ? fnSelectorAContainer! : fnSelectorBContainer!;
  container.replaceChildren(el('span', { class: 'profile-loading' }, 'Loading profile...'));

  try {
    const [metadata, funcResp] = await Promise.all([
      getProfileMetadata(state.suite, requestedUuid, controller?.signal),
      getProfileFunctions(state.suite, requestedUuid, controller?.signal),
    ]);
    // Guard against stale response if user changed selection during fetch
    if (state.profileUuid !== requestedUuid) return;
    state.metadata = metadata;
    state.functions = funcResp.functions;
    state.selectedFunction = '';
    state.functionDetail = null;

    updateCounterNames();
    renderStats();
    renderGlobalControls();
    renderFunctionSelector(side);
  } catch (e: unknown) {
    if (isAbort(e)) return;
    container.replaceChildren(el('span', { class: 'error-banner' }, `Failed to load profile: ${e}`));
  }
}

async function loadFunctionDetail(side: 'a' | 'b', fnName: string): Promise<void> {
  const state = side === 'a' ? sideA : sideB;
  if (!state.suite || !state.profileUuid) return;

  const requestedUuid = state.profileUuid;
  const viewerContainer = side === 'a' ? viewerAContainer! : viewerBContainer!;
  viewerContainer.replaceChildren(el('span', { class: 'profile-loading' }, 'Loading disassembly...'));

  try {
    const detail = await getProfileFunctionDetail(
      state.suite, requestedUuid, fnName, controller?.signal);
    // Guard against stale response if user changed profile during fetch
    if (state.profileUuid !== requestedUuid) return;
    state.functionDetail = detail;
    state.selectedFunction = fnName;
    renderViewer(side);
  } catch (e: unknown) {
    if (isAbort(e)) return;
    viewerContainer.replaceChildren(el('span', { class: 'error-banner' }, `Failed to load function: ${e}`));
  }
}

// ---------------------------------------------------------------------------
// URL state restoration
// ---------------------------------------------------------------------------

async function restoreFromUrl(
  runA: string, testA: string, runB: string, testB: string,
): Promise<void> {
  const promises: Promise<void>[] = [];
  if (runA) promises.push(restoreSide('a', runA, testA));
  if (runB) promises.push(restoreSide('b', runB, testB));
  await Promise.all(promises);
}

async function restoreSide(side: 'a' | 'b', runUuid: string, testName: string): Promise<void> {
  const state = side === 'a' ? sideA : sideB;

  try {
    // 1. Fetch run details to get machine + commit
    const runDetail = await getRun(state.suite, runUuid, controller?.signal);
    state.machine = runDetail.machine;
    state.commit = runDetail.commit;

    // 2. Load machine-commit set
    await loadMachineCommits(side, state.suite, state.machine);

    // 3. Fetch runs for machine+commit (only profile-bearing runs)
    const runs = await getRuns(
      state.suite,
      { machine: state.machine, commit: state.commit, has_profiles: true },
      controller?.signal,
    );
    state.runs = runs;

    // 4. Set run
    const matchedRun = runs.find(r => r.uuid === runUuid);
    if (matchedRun) {
      state.runUuid = runUuid;
    }

    // 5. Fetch profiles
    const profiles = await getProfilesForRun(state.suite, runUuid, controller?.signal);
    state.profiles = profiles;

    // 6. Match test
    if (testName) {
      const matchedProfile = profiles.find(p => p.test === testName);
      if (matchedProfile) {
        state.testName = testName;
        state.profileUuid = matchedProfile.uuid;
      }
    }

    // Re-render the side picker with restored state
    renderSidePickers();

    // Load profile data if test was matched
    if (state.profileUuid) {
      await loadProfile(side);
    }
  } catch (e: unknown) {
    if (isAbort(e)) return;
    // Show error and re-render with whatever state we have
    renderSidePickers();
  }
}

// ---------------------------------------------------------------------------
// Rendering: Side pickers
// ---------------------------------------------------------------------------

function renderSidePickers(): void {
  renderSidePicker('a');
  renderSidePicker('b');
}

function renderSidePicker(side: 'a' | 'b'): void {
  const container = side === 'a' ? sideAContainer! : sideBContainer!;
  const state = side === 'a' ? sideA : sideB;

  // Clear everything after the h3
  const heading = container.querySelector('h3');
  container.replaceChildren();
  if (heading) container.append(heading);

  // Suite selector (per-side)
  const suiteRow = el('div', { class: 'profile-cascade-row control-group' });
  suiteRow.append(el('label', {}, 'Suite'));
  const suiteSelect = el('select', { class: 'admin-input' }) as HTMLSelectElement;
  suiteSelect.append(el('option', { value: '' }, '-- Select suite --') as HTMLOptionElement);
  for (const ts of getTestsuites()) {
    const opt = el('option', { value: ts }, ts) as HTMLOptionElement;
    if (ts === state.suite) opt.selected = true;
    suiteSelect.append(opt);
  }
  suiteSelect.addEventListener('change', () => {
    const newSuite = suiteSelect.value;
    state.suite = newSuite;
    resetStateFrom(state, 'machine');
    clearDownstream(side, 'machine');
    clearProfileDisplay(side);
    if (newSuite && !commitFieldsCache.has(newSuite)) {
      getTestSuiteInfoCached(newSuite)
        .then(info => { commitFieldsCache.set(newSuite, info.schema.commit_fields); })
        .catch(() => {});
    }
    syncUrl();
    renderSidePicker(side);
  });
  suiteRow.append(suiteSelect);
  container.append(suiteRow);

  if (!state.suite) {
    container.append(el('span', { class: 'no-results' }, 'Select a suite first.'));
    return;
  }

  // Machine combobox
  const machineRow = el('div', { class: 'profile-cascade-row control-group' });
  machineRow.append(el('label', {}, 'Machine'));
  const machineContainer = el('div');
  const combo = renderMachineCombobox(machineContainer, {
    testsuite: state.suite,
    initialValue: state.machine,
    onSelect(name: string) {
      resetStateFrom(state, 'commit');
      state.machine = name;
      state.machineCommitsLoading = true;
      clearDownstream(side, 'machine');
      loadMachineCommits(side, state.suite, name).then(() => {
        const picker = side === 'a' ? commitPickerA : commitPickerB;
        if (picker) {
          picker.input.disabled = false;
          picker.input.placeholder = 'Type to search commits...';
        }
      });
      syncUrl();
    },
    onClear() {
      resetStateFrom(state, 'machine');
      clearDownstream(side, 'machine');
      syncUrl();
    },
  });

  if (side === 'a') {
    machineComboA?.destroy();
    machineComboA = combo;
  } else {
    machineComboB?.destroy();
    machineComboB = combo;
  }

  machineRow.append(machineContainer);
  container.append(machineRow);

  // Commit picker
  const commitRow = el('div', { class: 'profile-cascade-row control-group' });
  commitRow.append(el('label', {}, 'Commit'));
  const commitContainer = el('div');
  const cpId = `profiles-commit-${side}`;
  const picker = createCommitPicker({
    id: cpId,
    getCommitData: () => {
      const commits = state.machineCommits ?? [];
      const values = commits.map(c => c.commit);
      const cf = state.suite ? commitFieldsCache.get(state.suite) : undefined;
      let displayMap: Map<string, string> | undefined;
      if (cf) {
        displayMap = new Map<string, string>();
        for (const c of commits) {
          const display = commitDisplayValue(c, cf);
          if (display !== c.commit) displayMap.set(c.commit, display);
        }
        if (displayMap.size === 0) displayMap = undefined;
      }
      return { values, displayMap };
    },
    initialValue: state.commit,
    placeholder: state.machine
      ? (state.machineCommitsLoading ? 'Loading commits...' : 'Type to search commits...')
      : 'Select a machine first',
    onSelect(value: string) {
      resetStateFrom(state, 'run');
      state.commit = value;
      clearDownstream(side, 'commit');
      loadRuns(side);
      syncUrl();
    },
  });

  if (!state.machine) {
    picker.input.disabled = true;
  }

  if (side === 'a') {
    commitPickerA?.destroy();
    commitPickerA = picker;
  } else {
    commitPickerB?.destroy();
    commitPickerB = picker;
  }

  commitContainer.append(picker.element);
  commitRow.append(commitContainer);
  container.append(commitRow);

  // Run select
  const runRow = el('div', { class: 'profile-cascade-row control-group' });
  runRow.append(el('label', {}, 'Run'));
  const runSelectContainer = el('div');
  runRow.append(runSelectContainer);
  container.append(runRow);

  // Test select
  const testRow = el('div', { class: 'profile-cascade-row control-group' });
  testRow.append(el('label', {}, 'Test'));
  const testSelectContainer = el('div');
  testRow.append(testSelectContainer);
  container.append(testRow);

  // Store containers for dynamic updates
  cascadeRefs.set(side, { runContainer: runSelectContainer, testContainer: testSelectContainer });

  // Render run/test selects if state is already populated (URL restoration)
  if (state.runs.length > 0) {
    renderRunSelectInto(side, runSelectContainer);
  } else {
    renderDisabledSelect(runSelectContainer, 'Select a commit first');
  }

  if (state.profiles.length > 0) {
    renderTestSelectInto(side, testSelectContainer);
  } else if (state.runUuid && state.profiles.length === 0 && state.runs.length > 0) {
    renderEmptyMessage(testSelectContainer, 'No tests with profiles in this run.');
  } else {
    renderDisabledSelect(testSelectContainer, 'Select a run first');
  }
}

// ---------------------------------------------------------------------------
// Rendering: Run and Test selects
// ---------------------------------------------------------------------------

function getRunContainer(side: 'a' | 'b'): HTMLElement | null {
  return cascadeRefs.get(side)?.runContainer ?? null;
}

function getTestContainer(side: 'a' | 'b'): HTMLElement | null {
  return cascadeRefs.get(side)?.testContainer ?? null;
}

function renderRunSelect(side: 'a' | 'b'): void {
  const container = getRunContainer(side);
  if (!container) return;
  renderRunSelectInto(side, container);
}

function renderRunSelectInto(side: 'a' | 'b', container: HTMLElement): void {
  const state = side === 'a' ? sideA : sideB;
  container.replaceChildren();

  if (state.runs.length === 0) {
    container.append(el('span', { class: 'no-results' }, 'No runs found.'));
    return;
  }

  const select = el('select', { class: 'admin-input' }) as HTMLSelectElement;
  select.append(el('option', { value: '' }, '-- Select run --') as HTMLOptionElement);
  for (const run of state.runs) {
    const label = `${run.submitted_at || 'unknown'} ${run.uuid.slice(0, 8)}`;
    const opt = el('option', { value: run.uuid }, label) as HTMLOptionElement;
    if (run.uuid === state.runUuid) opt.selected = true;
    select.append(opt);
  }

  select.addEventListener('change', () => {
    resetStateFrom(state, 'test');
    state.runUuid = select.value;
    clearDownstream(side, 'run');
    syncUrl();
    if (select.value) {
      loadProfiles(side);
    } else {
      renderTestSelect(side);
    }
  });

  container.append(select);
}

function renderTestSelect(side: 'a' | 'b'): void {
  const container = getTestContainer(side);
  if (!container) return;
  renderTestSelectInto(side, container);
}

function renderTestSelectInto(side: 'a' | 'b', container: HTMLElement): void {
  const state = side === 'a' ? sideA : sideB;
  container.replaceChildren();

  if (!state.runUuid) {
    renderDisabledSelect(container, 'Select a run first');
    return;
  }

  if (state.profiles.length === 0) {
    container.append(el('span', { class: 'no-results' }, 'No tests with profiles in this run.'));
    return;
  }

  const select = el('select', { class: 'admin-input' }) as HTMLSelectElement;
  select.append(el('option', { value: '' }, '-- Select test --') as HTMLOptionElement);
  for (const profile of state.profiles) {
    const opt = el('option', { value: profile.test }, profile.test) as HTMLOptionElement;
    if (profile.test === state.testName) opt.selected = true;
    select.append(opt);
  }

  select.addEventListener('change', () => {
    const testName = select.value;
    const matched = state.profiles.find(p => p.test === testName);
    state.testName = testName;
    state.profileUuid = matched?.uuid || '';
    state.metadata = null;
    state.functions = [];
    state.selectedFunction = '';
    state.functionDetail = null;
    syncUrl();
    if (state.profileUuid) {
      loadProfile(side);
    } else {
      clearProfileDisplay(side);
    }
  });

  container.append(select);
}

function renderDisabledSelect(container: HTMLElement, placeholder: string): void {
  const select = el('select', { class: 'admin-input', disabled: 'true' }) as HTMLSelectElement;
  select.append(el('option', { value: '' }, placeholder) as HTMLOptionElement);
  container.replaceChildren(select);
}

function renderEmptyMessage(container: HTMLElement, msg: string): void {
  container.replaceChildren(el('span', { class: 'no-results' }, msg));
}

// ---------------------------------------------------------------------------
// Rendering: Stats, controls, function selectors, viewers
// ---------------------------------------------------------------------------

function updateCounterNames(): void {
  const namesA = sideA.metadata ? Object.keys(sideA.metadata.counters) : [];
  const namesB = sideB.metadata ? Object.keys(sideB.metadata.counters) : [];
  const allNames = [...new Set([...namesA, ...namesB])].sort();

  if (allNames.length > 0 && (!selectedCounter || !allNames.includes(selectedCounter))) {
    selectedCounter = allNames[0];
  }
}

function renderStats(): void {
  if (!statsContainer) return;
  statsHandle?.destroy();
  statsHandle = null;

  if (sideA.metadata && sideB.metadata) {
    statsHandle = renderProfileStats(statsContainer, sideA.metadata.counters, sideB.metadata.counters);
  } else if (sideA.metadata) {
    statsHandle = renderProfileStats(statsContainer, sideA.metadata.counters);
  } else {
    statsContainer.replaceChildren();
  }
}

function renderGlobalControls(): void {
  if (!controlsContainer) return;
  controlsContainer.replaceChildren();

  const allCounterNames = getAllCounterNames();
  if (allCounterNames.length === 0) return;

  // Counter selector
  const counterGroup = el('div', { class: 'control-group' });
  counterGroup.append(el('label', {}, 'Counter'));
  counterSelect = el('select', { class: 'admin-input' }) as HTMLSelectElement;
  for (const name of allCounterNames) {
    const opt = el('option', { value: name }, name) as HTMLOptionElement;
    if (name === selectedCounter) opt.selected = true;
    counterSelect.append(opt);
  }
  counterSelect.addEventListener('change', () => {
    selectedCounter = counterSelect!.value;
    rerenderViewers();
    rerenderFunctionSelectors();
  });
  counterGroup.append(counterSelect);
  controlsContainer.append(counterGroup);

  // Display mode selector
  const modeGroup = el('div', { class: 'control-group' });
  modeGroup.append(el('label', {}, 'Display'));
  displayModeSelect = el('select', { class: 'admin-input' }) as HTMLSelectElement;
  for (const mode of ['relative', 'absolute', 'cumulative'] as DisplayMode[]) {
    const opt = el('option', { value: mode }, mode.charAt(0).toUpperCase() + mode.slice(1)) as HTMLOptionElement;
    if (mode === displayMode) opt.selected = true;
    displayModeSelect.append(opt);
  }
  displayModeSelect.addEventListener('change', () => {
    displayMode = displayModeSelect!.value as DisplayMode;
    rerenderViewers();
  });
  modeGroup.append(displayModeSelect);
  controlsContainer.append(modeGroup);
}

function getAllCounterNames(): string[] {
  const names = new Set<string>();
  for (const fn of sideA.functions) {
    for (const k of Object.keys(fn.counters)) names.add(k);
  }
  for (const fn of sideB.functions) {
    for (const k of Object.keys(fn.counters)) names.add(k);
  }
  // Also add from metadata
  if (sideA.metadata) for (const k of Object.keys(sideA.metadata.counters)) names.add(k);
  if (sideB.metadata) for (const k of Object.keys(sideB.metadata.counters)) names.add(k);
  return [...names].sort();
}

function renderFunctionSelector(side: 'a' | 'b'): void {
  const container = side === 'a' ? fnSelectorAContainer! : fnSelectorBContainer!;
  const state = side === 'a' ? sideA : sideB;
  container.replaceChildren();

  if (state.functions.length === 0) return;

  // Sort by selected counter value (hottest first)
  const sorted = [...state.functions].sort((a, b) => {
    const va = a.counters[selectedCounter] ?? 0;
    const vb = b.counters[selectedCounter] ?? 0;
    return vb - va;
  });

  const wrapper = el('div', { class: 'profile-fn-combobox combobox' });
  const input = el('input', {
    type: 'text',
    class: 'combobox-input',
    placeholder: 'Type to search functions...',
    autocomplete: 'off',
  }) as HTMLInputElement;
  const dropdown = el('ul', { class: 'combobox-dropdown' });
  wrapper.append(input, dropdown);

  function showDropdown(filter: string): void {
    dropdown.replaceChildren();
    const matches = filter.trim()
      ? sorted.filter(fn => matchesFilter(fn.name, filter))
      : sorted;

    for (const fn of matches.slice(0, 100)) {
      const pct = fn.counters[selectedCounter] ?? 0;
      const li = el('li', { class: 'combobox-item', tabindex: '-1' });
      const badge = el('span', { class: 'profile-fn-badge' }, `${pct.toFixed(1)}%`);
      badge.style.backgroundColor = heatGradient(pct / 100);
      li.append(badge, document.createTextNode(` ${fn.name}`));
      li.addEventListener('click', () => {
        input.value = fn.name;
        dropdown.classList.remove('open');
        loadFunctionDetail(side, fn.name);
      });
      dropdown.append(li);
    }

    dropdown.classList.toggle('open', matches.length > 0);
  }

  input.addEventListener('input', () => {
    updateFilterValidation(input);
    showDropdown(input.value);
  });
  input.addEventListener('focus', () => showDropdown(input.value));
  input.addEventListener('blur', (e: FocusEvent) => {
    if (wrapper.contains(e.relatedTarget as Node)) return;
    dropdown.classList.remove('open');
  });

  // Prevent dropdown clicks from blurring input
  dropdown.addEventListener('mousedown', (e) => e.preventDefault());

  // Keyboard navigation
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const first = dropdown.querySelector<HTMLElement>('.combobox-item');
      if (first) first.focus();
    } else if (e.key === 'Escape') {
      dropdown.classList.remove('open');
    }
  });
  dropdown.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = target.nextElementSibling as HTMLElement | null;
      if (next) next.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = target.previousElementSibling as HTMLElement | null;
      if (prev) prev.focus();
      else input.focus();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      target.click();
    } else if (e.key === 'Escape') {
      dropdown.classList.remove('open');
      input.focus();
    }
  });

  container.append(wrapper);

  // If a function was already selected (restoration), set it
  if (state.selectedFunction) {
    input.value = state.selectedFunction;
  }
}

function rerenderFunctionSelectors(): void {
  if (sideA.functions.length > 0) renderFunctionSelector('a');
  if (sideB.functions.length > 0) renderFunctionSelector('b');
}

function renderViewer(side: 'a' | 'b'): void {
  const container = side === 'a' ? viewerAContainer! : viewerBContainer!;
  const state = side === 'a' ? sideA : sideB;
  const handle = side === 'a' ? viewerHandleA : viewerHandleB;

  // Preserve "show all" state across re-renders
  const prevShowAll = handle?.isShowAll() ?? false;
  handle?.destroy();

  if (!state.functionDetail) {
    container.replaceChildren();
    return;
  }

  const newHandle = renderProfileViewer(container, state.functionDetail, {
    counter: selectedCounter,
    displayMode,
    showAll: prevShowAll,
  });

  if (side === 'a') viewerHandleA = newHandle;
  else viewerHandleB = newHandle;
}

function rerenderViewers(): void {
  if (sideA.functionDetail) renderViewer('a');
  if (sideB.functionDetail) renderViewer('b');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reset all state downstream of (and including) the given level. */
function resetStateFrom(state: SideState, level: 'machine' | 'commit' | 'run' | 'test'): void {
  if (level === 'machine') { state.machine = ''; state.machineCommits = null; state.machineCommitsLoading = false; }
  if (level === 'machine' || level === 'commit') { state.commit = ''; state.runs = []; }
  if (level === 'machine' || level === 'commit' || level === 'run') { state.runUuid = ''; state.profiles = []; }
  state.testName = '';
  state.profileUuid = '';
  state.metadata = null;
  state.functions = [];
  state.selectedFunction = '';
  state.functionDetail = null;
}

function clearDownstream(side: 'a' | 'b', from: 'machine' | 'commit' | 'run'): void {
  if (from === 'machine' || from === 'commit') {
    const runContainer = getRunContainer(side);
    if (runContainer) renderDisabledSelect(runContainer, 'Select a commit first');
  }
  if (from === 'machine' || from === 'commit' || from === 'run') {
    const testContainer = getTestContainer(side);
    if (testContainer) renderDisabledSelect(testContainer, 'Select a run first');
  }

  clearProfileDisplay(side);
}

function clearProfileDisplay(side: 'a' | 'b'): void {
  const fnContainer = side === 'a' ? fnSelectorAContainer : fnSelectorBContainer;
  const viewerContainer = side === 'a' ? viewerAContainer : viewerBContainer;
  if (fnContainer) fnContainer.replaceChildren();
  if (viewerContainer) viewerContainer.replaceChildren();

  // Update stats if needed
  renderStats();
  renderGlobalControls();
}

function syncUrl(): void {
  const params = new URLSearchParams();
  if (sideA.suite) params.set('suite_a', sideA.suite);
  if (sideA.runUuid) params.set('run_a', sideA.runUuid);
  if (sideA.testName) params.set('test_a', sideA.testName);
  if (sideB.suite) params.set('suite_b', sideB.suite);
  if (sideB.runUuid) params.set('run_b', sideB.runUuid);
  if (sideB.testName) params.set('test_b', sideB.testName);

  const search = params.toString();
  const newUrl = `${window.location.pathname}${search ? '?' + search : ''}`;
  history.replaceState(null, '', newUrl);
}

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

function cleanup(): void {
  if (controller) { controller.abort(); controller = null; }
  machineComboA?.destroy(); machineComboA = null;
  machineComboB?.destroy(); machineComboB = null;
  commitPickerA?.destroy(); commitPickerA = null;
  commitPickerB?.destroy(); commitPickerB = null;
  statsHandle?.destroy(); statsHandle = null;
  viewerHandleA?.destroy(); viewerHandleA = null;
  viewerHandleB?.destroy(); viewerHandleB = null;
  if (machineCommitsAbortA) { machineCommitsAbortA.abort(); machineCommitsAbortA = null; }
  if (machineCommitsAbortB) { machineCommitsAbortB.abort(); machineCommitsAbortB = null; }
  sideA = initialSideState();
  sideB = initialSideState();
  cascadeRefs.clear();
  selectedCounter = '';
  displayMode = 'relative';
  sideAContainer = null;
  sideBContainer = null;
  statsContainer = null;
  controlsContainer = null;
  fnSelectorAContainer = null;
  fnSelectorBContainer = null;
  viewerAContainer = null;
  viewerBContainer = null;
  counterSelect = null;
  displayModeSelect = null;
}
