// When to page. One incident per pane: it opens on the first request served by a fallback step
// or by no step at all, and closes after RECOVERY_CLEAN consecutive clean step-1 requests. One
// page when it opens, one when it closes, nothing in between however much it flaps. Pure.
//
// Decisions look at each new request, not only the pane's state at the end of a poll, so a
// fallback that recovers within one poll interval still opens (and then closes) an incident.
'use strict';

const { classify, isBad } = require('./audit.js');

const RECOVERY_CLEAN = 3;

function newIncidentState() {
  return { open: false, clean: 0, openedBy: null };
}

// Feed the rows newly attributed to one pane, oldest first. Returns [{ event, row, c }] where
// event is 'degraded' or 'recovered'. `state` is updated in place.
function advance(state, rows, combos) {
  const events = [];
  for (const row of rows) {
    const c = classify(row, combos.get(row.combo_name));
    if (isBad(c)) {
      state.clean = 0;
      if (!state.open) {
        state.open = true;
        state.openedBy = row;
        events.push({ event: 'degraded', row, c });
      }
    } else if (c.outcome === 'PRIMARY' && !c.error) {
      if (state.open) {
        state.clean += 1;
        if (state.clean >= RECOVERY_CLEAN) {
          state.open = false;
          state.clean = 0;
          state.openedBy = null;
          events.push({ event: 'recovered', row, c });
        }
      }
    } else if (c.outcome === 'PRIMARY' && c.error) {
      state.clean = 0; // a step-1 error neither opens nor closes an incident
    }
    // UNKNOWN / ANY / HISTORICAL rows say nothing about recovery and leave the count alone.
  }
  return events;
}

module.exports = { RECOVERY_CLEAN, newIncidentState, advance };
