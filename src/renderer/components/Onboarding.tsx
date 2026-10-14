import { useState } from "react";
import { actions, toast, useDeck } from "../state/store";
import { FOLDER, FOLDER_SUGGESTIONS, TEAM_PRESETS } from "../mock/fixtures";
import { Icon } from "./ui";
import { AppearanceToggle } from "./Appearance";
import { deckApi, pickFolder } from "../real/api";

const STEPS = ["Choose a folder", "Live mode", "Token limits", "Your team"];

const HOOKS_PREVIEW = `.claude/settings.local.json   (personal · already git-ignored)
{
+  "hooks": {
+    "PreToolUse":  [{ "matcher": "*", "hooks": [{ "type": "command",
+        "command": "\\"~/Library/Application Support/Crewglass/bin/crewglass-hook\\"",
+        "timeout": 150 }] }],
+    "PostToolUse": [ … same helper … ],
+    "Stop":        [ … ], "SubagentStop": [ … ], "UserPromptSubmit": [ … ], …
+  }
}`;

export function Onboarding() {
  const step = useDeck((s) => s.onboardStep);
  const real = useDeck((s) => s.mode === "real");
  // In the real app, snapshots keep refreshing the store every second, so the wizard keeps its own choices
  // (folder, limits, Live mode, preset) until you press Start — otherwise they'd be reset under you.
  const storeFolder = useDeck((s) => s.folder);
  const storeLimits = useDeck((s) => s.limits);
  const [chosenFolder, setChosenFolder] = useState("");
  const [chosenLimits, setChosenLimits] = useState(storeLimits);
  const folder = real ? chosenFolder : storeFolder;
  const limits = real ? chosenLimits : storeLimits;
  const setLimits = (l: { session: number; day: number }) => (real ? setChosenLimits(l) : useDeck.setState({ limits: l }));
  const [over, setOver] = useState(false);
  const [preset, setPreset] = useState("plan-code-review");
  const [picked, setPicked] = useState(false);
  // The wizard keeps its own Live mode choice (in the real app, snapshots keep updating the store's liveMode).
  const [liveChoice, setLiveChoiceState] = useState(true);
  const setLiveChoice = (on: boolean) => { setLiveChoiceState(on); if (useDeck.getState().mode !== "real") useDeck.setState({ liveMode: on }); };
  const realSuggestions = useDeck((s) => s.suggestions);
  const suggestions = real ? realSuggestions : FOLDER_SUGGESTIONS;
  const go = (n: number) => useDeck.setState({ onboardStep: n });
  const choose = (path: string) => { if (real) setChosenFolder(path); else useDeck.setState({ folder: path }); setPicked(true); };
  const chooseWithPicker = async () => {
    const api = deckApi();
    if (!api) return choose(FOLDER);
    const p = await api.chooseFolder();
    if (p) choose(p);
  };
  const finish = async () => {
    if (!real) return actions.finishOnboarding(preset);
    const api = deckApi()!;
    await api.setLimits(limits);
    // A preset is applied once this folder's first snapshot has arrived (so it builds on the folder's real agents).
    useDeck.setState({ pendingPreset: preset === "watch" ? null : preset });
    if (!(await pickFolder(folder))) { useDeck.setState({ pendingPreset: null }); toast("Couldn't watch that folder", "Choose the folder again."); return; }
    if (liveChoice) {
      const r = await api.setLiveMode(true);
      toast(r.ok ? "Live mode is on" : "Live mode wasn't turned on", r.ok ? "It starts on Claude's next turn in this folder. Turn it off any time from the right-hand panel." : r.error ?? "");
    }
  };

  return (
    <div className="onboard">
      <div className="onboard-card" role="dialog" aria-label="Set up Crewglass">
        <div className="onboard-steps">
          {STEPS.map((t, i) => (
            <div key={t} className={`s ${i === step ? "on" : ""} ${i < step ? "done" : ""}`}>
              <span className="n">{i < step ? "✓" : i + 1}</span>{t}{i < STEPS.length - 1 && <span style={{ margin: "0 6px" }}>›</span>}
            </div>
          ))}
          <div className="spacer" />
          <AppearanceToggle />
        </div>

        <div className="onboard-body">
          {step === 0 && <>
            <h1>Which folder should Crewglass watch?</h1>
            <div className="ink2">Crewglass shows Claude Code activity in <b>this folder and its subfolders only</b>. Everything else on your Mac is ignored.</div>
            <div className={`dropzone ${over ? "over" : ""}`} onDragOver={(e) => { if (!real) { e.preventDefault(); setOver(true); } }} onDragLeave={() => setOver(false)}
              onDrop={(e) => { e.preventDefault(); setOver(false); choose(FOLDER); }}>
              <Icon name="folder" size={28} />
              {picked && real ? <div style={{ marginTop: 6 }} className="mono">{folder}</div> : !real && <div style={{ marginTop: 6 }}>Drag a folder here from Finder, or</div>}
              <button className="btn primary" style={{ marginTop: 8 }} onClick={() => void chooseWithPicker()}>{picked && real ? "Choose a different folder…" : "Choose folder…"}</button>
            </div>
            {suggestions.length > 0 && <div className="lib-sub" style={{ padding: 0 }}>Suggestions</div>}
            {suggestions.map((f) => (
              <button key={f.path} className={`choice ${picked && folder === f.path ? "on" : ""}`} onClick={() => choose(f.path)}>
                <Icon name="folder" /><div className="grow"><div style={{ fontWeight: 600 }}>{f.path.split("/").pop()}</div><div className="mono muted" style={{ fontSize: 11 }}>{f.path}</div></div>
                <span className="badge">{f.why}</span>
              </button>
            ))}
          </>}

          {step === 1 && <>
            <h1>Turn on Live mode for this folder?</h1>
            <div className="ink2">Without it, Crewglass still shows everything, about a second behind. With it, you also get:</div>
            <ul style={{ margin: 0, paddingLeft: 20, lineHeight: 1.7 }}>
              <li><b>Stop</b> — halt Claude cleanly in one click</li>
              <li>The <b>failing-command breaker</b> and <b>checks</b> that send work back to be fixed</li>
              <li><b>Approvals</b> for subagents calling other subagents</li>
              <li>A pop-up when <b>Claude needs your permission</b></li>
            </ul>
            <div className="codebox">{HOOKS_PREVIEW}</div>
            <div className="muted small">Only this folder is changed. If Crewglass is closed, the helper allows everything and Claude works normally. You can turn it off any time.</div>
            {(
              <div className="grid2">
                <button className={`choice ${liveChoice ? "on" : ""}`} onClick={() => setLiveChoice(true)}><div><b>Turn on (recommended)</b><div className="muted small">Adds the hooks above</div></div></button>
                <button className={`choice ${!liveChoice ? "on" : ""}`} onClick={() => setLiveChoice(false)}><div><b>Not now</b><div className="muted small">Watch only</div></div></button>
              </div>
            )}
          </>}

          {step === 2 && <>
            <h1>Token limits</h1>
            <div className="ink2">{real
              ? <>How much should Claude use in <b>{folder.split("/").pop()}</b> before Crewglass warns you? In API-equivalent dollars: what the usage would cost at Claude API prices, even on a subscription. You can change this any time in Settings.</>
              : <>From the last 30 days in <b>{folder.split("/").pop()}</b>: an average session cost <b>$6</b> and your busiest day <b>$41</b> (API-equivalent).</>}</div>
            <div className="grid2">
              <div className="field"><label>Warn me when one session uses</label>
                <select className="select" value={limits.session} onChange={(e) => setLimits({ ...limits, session: Number(e.target.value) })}>
                  {[10, 25, 50, 100].map((v) => <option key={v} value={v}>${v}{v === 25 ? " (suggested)" : ""}</option>)}
                </select></div>
              <div className="field"><label>Warn me when this folder uses, per day</label>
                <select className="select" value={limits.day} onChange={(e) => setLimits({ ...limits, day: Number(e.target.value) })}>
                  {[25, 50, 100, 200].map((v) => <option key={v} value={v}>${v}{v === 50 ? " (suggested)" : ""}</option>)}
                </select></div>
            </div>
            <div className="hint"><Icon name="info" size={15} /><span>You get a quiet heads-up at 80% and a pop-up at 100%. <b>Claude is never stopped automatically</b> — the Stop button is always one click away. With Live mode, a command that fails 3 times in a row is paused, and you decide what happens next.</span></div>
          </>}

          {step === 3 && <>
            <h1>Set up a team, or just watch</h1>
            <div className="ink2">A preset puts agents on the canvas. Nothing is written until you review the changes and press Save.</div>
            {real && <div className="hint"><span>A preset only adds what's missing — agents you already have in this folder are kept and reused.</span></div>}
            {TEAM_PRESETS.map((p) => (
              <button key={p.id} className={`choice ${preset === p.id ? "on" : ""}`} onClick={() => setPreset(p.id)}>
                <Icon name={p.id === "watch" ? "eye" : "team"} />
                <div className="grow"><div style={{ fontWeight: 600 }}>{p.name}{p.recommended && <span className="badge info" style={{ marginLeft: 6 }}>recommended</span>}</div><div className="muted small">{p.detail}</div></div>
              </button>
            ))}
          </>}
        </div>

        <div className="onboard-foot">
          {!real && <button className="btn ghost small" onClick={() => actions.skipOnboarding()} title="Prototype shortcut">Skip — show a folder that's already set up</button>}
          <div className="spacer" />
          {step > 0 && <button className="btn" onClick={() => go(step - 1)}>Back</button>}
          {step < 3 && <button className="btn primary" disabled={step === 0 && !picked} onClick={() => go(step + 1)}>Continue</button>}
          {step === 3 && <button className="btn primary" onClick={() => void finish()}>{real ? "Start watching" : "Finish"}</button>}
        </div>
      </div>
    </div>
  );
}
