#!/usr/bin/env bun

import { createCliRenderer } from "@opentui/core";
import { state } from "./tui/state.js";
import { initApp } from "./tui/app.js";

const renderer = await createCliRenderer({ exitOnCtrlC: false });

state.renderer = renderer;
initApp();
