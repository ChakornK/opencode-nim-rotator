#!/usr/bin/env bun

import { createCliRenderer } from "@opentui/core";
import { state } from "../src/tui/state.js";
import { initApp } from "../src/tui/app.js";

const renderer = await createCliRenderer({ exitOnCtrlC: false });

state.renderer = renderer;
initApp();
