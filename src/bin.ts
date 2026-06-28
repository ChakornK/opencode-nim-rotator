#!/usr/bin/env bun

import { createCliRenderer } from "@opentui/core";
import { initApp } from "./tui/app.js";
import { state } from "./tui/state.js";

const renderer = await createCliRenderer({ exitOnCtrlC: false });

state.renderer = renderer;
initApp();
