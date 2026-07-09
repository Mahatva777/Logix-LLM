import { Component } from "react";
import { C1Chat, ThemeProvider } from "@thesysai/genui-sdk";
import { themePresets } from "@crayonai/react-ui";
import "@crayonai/react-ui/styles/index.css";

// "Advance Generative UI" -- an intentionally isolated sandbox tab. It talks
// to /api/chat/thesys (Thesys C1, an OpenAI-compatible endpoint that returns
// a UI spec instead of markdown) via <C1Chat>, NOT to /chat, /chat/general,
// or /chat/portfolio. It does not use guardrails.py, the citation system, or
// the Answer/Considerations/Note contract -- see thesys_chat.py's docstring
// for why that's deliberate.
//
// ============================================================================
// THEMING: WHAT CRAYON ACTUALLY LETS YOU CONTROL (read before the demo)
// ============================================================================
// You asked for --ink #12222B / --jade #1F7A5C / --bronze #C08B2C /
// --paper #EEF1EC to be matched "as close as reasonably possible." Here's
// the honest split, checked against Thesys's own docs as of this writing:
//
// CONTROLLABLE, DOCUMENTED:
//   - <ThemeProvider theme={...} darkTheme={...} mode="light"|"dark">
//     accepts a theme object and switches between light/dark. Thesys ships
//     named presets (themePresets.candy, .carbon, .play, .neon, ...) that
//     are guaranteed to work and look coherent out of the box.
//   - CSS overrides: Crayon-generated markup carries stable-ish class names
//     (Thesys's own example: `.crayon-header` for card titles) that you can
//     target with plain CSS after the component mounts.
//
// NOT CURRENTLY DOCUMENTED (checked docs.thesys.dev/guides/styling/theming
// as of this writing -- it literally says "a detailed guide on the theme
// object's structure and all available tokens is coming soon"):
//   - The exact JSON shape / key names of a fully custom `theme` object.
//     There is no published list of "these are the N color/spacing/font
//     tokens you may set." Because of that, I'm NOT fabricating a custom
//     theme object with guessed key names below -- shipping code with
//     invented, unverified field names would silently no-op or throw, and
//     you'd only find out at demo time.
//   - Which specific `.crayon-*` / `.c1-*` class names exist beyond the one
//     example Thesys documents (`.crayon-header`). Thesys's own CSS-override
//     guide says the reliable way to find them is browser devtools
//     inspection, and explicitly warns class names "can change between SDK
//     versions" -- there is no stable published list to code against ahead
//     of time.
//
// WHAT THIS FILE ACTUALLY DOES, GIVEN THAT:
//   1. Starts from themePresets.candy as the base (documented, guaranteed
//      to render correctly -- picked as the closest built-in preset to a
//      light, editorial financial UI; swap for another preset name if you
//      prefer after eyeballing it live).
//   2. Layers a CSS override block, scoped under .agu-shell so it can never
//      leak into the other three tabs, that maps your four palette values
//      onto the ONE confirmed-stable selector Thesys documents
//      (`.crayon-header`) plus CSS custom properties on the wrapper so any
//      Crayon internals that happen to read inherited CSS vars pick them
//      up too. This is a best-effort layer, not a guarantee.
//   3. Leaves clearly marked TODO selectors for you to fill in at the demo
//      machine: open devtools on this tab, inspect a card/button/chart,
//      copy the real class name, and drop it into the CSS block below.
//      Budget 10-15 minutes for this pass before presenting -- it's a
//      one-time cost, not a per-message one.
//
// Bottom line to say out loud in the discussion round if asked: Crayon's
// theming system covers "look like one of our presets, in light or dark."
// Pixel-matching an arbitrary external brand palette is currently a
// CSS-override exercise done by hand against undocumented, version-fragile
// class names -- not a first-class, guaranteed theming API yet.
// ============================================================================

const MLX = {
  ink: "#12222B",
  jade: "#1F7A5C",
  bronze: "#C08B2C",
  paper: "#EEF1EC",
};

// ---------------------------------------------------------------------------
// Point 4: fallback handling for malformed/unstable generated UI.
// The backend (thesys_chat.py) already has a server-side try/except that
// drops back to plain custom markdown if generation itself fails. This
// catches the OTHER failure mode Thesys's docs call out: a response that
// streams fine but the SDK can't render (a malformed or unstable DSL
// fragment) -- that throws INSIDE C1Chat's render tree, which only a React
// error boundary can catch. Good enough for a hackathon demo per the brief;
// not attempting retry/reset-on-next-message sophistication here.
// ---------------------------------------------------------------------------
class GenUIErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    console.error("Advance Generative UI: C1Chat failed to render.", error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="agu-fallback">
          <p className="agu-fallback-title">This response couldn't be rendered.</p>
          <p className="agu-fallback-body">
            The generated UI came back malformed or unstable -- Thesys's own docs note this can
            happen occasionally. Try sending your question again; if it keeps failing, try
            rephrasing it.
          </p>
          <button
            type="button"
            className="agu-fallback-retry"
            onClick={() => this.setState({ hasError: false })}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function AdvanceGenerativeUI() {
  return (
    <div className="agu-shell">
      <style>{`
        .agu-shell {
          --agu-ink: ${MLX.ink};
          --agu-jade: ${MLX.jade};
          --agu-bronze: ${MLX.bronze};
          --agu-paper: ${MLX.paper};
          min-height: 70vh;
          background: var(--agu-paper);
        }

        .agu-banner {
          max-width: 72rem; margin: 0 auto; padding: 1rem 1.25rem 0;
          font-family: 'Inter', sans-serif;
        }
        .agu-banner-inner {
          background: #fff; border: 1px dashed var(--agu-bronze); border-radius: 12px;
          padding: 0.65rem 1rem; font-size: 12.5px; color: var(--agu-ink);
          display: flex; align-items: center; gap: 0.5rem;
        }
        .agu-banner-dot {
          width: 7px; height: 7px; border-radius: 999px; background: var(--agu-bronze);
          flex-shrink: 0;
        }

        .agu-chat-wrap { max-width: 72rem; margin: 0 auto; padding: 0.75rem 1.25rem 1.5rem; height: 75vh; }

        /* --- Best-effort palette mapping onto the one Thesys-documented
           stable selector, plus CSS vars for anything that inherits them.
           TODO before demo: devtools-inspect this tab, replace/extend the
           selectors below with the real class names you find (card
           background, primary button, chart series colors, etc). --- */
        .agu-chat-wrap .crayon-header {
          color: var(--agu-ink);
        }
        .agu-chat-wrap {
          /* Best-effort: if Crayon internals read inherited custom
             properties for accent/surface colors, this gives them your
             palette; unconfirmed against Crayon's actual internals since
             the token schema isn't published yet -- verify live. */
          --crayon-accent-color: var(--agu-jade);
          --crayon-surface-color: #ffffff;
          --crayon-background-color: var(--agu-paper);
          --crayon-text-color: var(--agu-ink);
        }

        .agu-fallback {
          max-width: 32rem; margin: 2rem auto; padding: 1.5rem;
          background: #fff; border: 1px solid var(--agu-bronze); border-radius: 12px;
          font-family: 'Inter', sans-serif; text-align: center;
        }
        .agu-fallback-title { font-weight: 700; color: var(--agu-ink); margin: 0 0 0.4rem; }
        .agu-fallback-body { font-size: 13px; color: var(--agu-ink); opacity: 0.75; margin: 0 0 1rem; }
        .agu-fallback-retry {
          font-size: 12.5px; font-weight: 600; color: #fff; background: var(--agu-jade);
          border: none; border-radius: 8px; padding: 0.5rem 1rem; cursor: pointer;
        }
      `}</style>

      <div className="agu-banner">
        <div className="agu-banner-inner">
          <span className="agu-banner-dot" aria-hidden="true" />
          Sandbox mode -- open exploration across any stock, not limited to MoneyLogix's 5 curated
          tickers. Not covered by the citation and compliance checks used elsewhere in the app.
        </div>
      </div>

      <div className="agu-chat-wrap">
        <GenUIErrorBoundary>
          <ThemeProvider theme={themePresets.candy.theme} darkTheme={themePresets.candy.darkTheme} mode="light">
            <C1Chat apiUrl="/api/chat/thesys" agentName="Advance Generative UI" formFactor="full-page" />
          </ThemeProvider>
        </GenUIErrorBoundary>
      </div>
    </div>
  );
}
