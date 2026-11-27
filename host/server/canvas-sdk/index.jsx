// RokBot canvas SDK: the browser runtime behind `cursor/canvas` (and `rokbot/canvas`).
// A canvas module imports everything it needs from here; the host bundles it with React.
import { injectStyles } from "./theme.js";

injectStyles();

export { useEffect, useMemo, useRef, useState, useCallback, useReducer, Fragment } from "react";

export {
  canvasPaletteDark, canvasPaletteLight, canvasPaletteGrokDark, canvasPaletteGrokLight,
  canvasTokens, canvasTokensLight, categoryPaletteDark, categoryPaletteLight, colorPalette, usageColorSequence,
  chartPalette, chartColorSequence, canvasTypography, canvasSpacing, canvasRadius,
} from "./theme.js";
export { useHostTheme, useCanvasState, useCanvasAction } from "./hooks.js";
export {
  mergeStyle, Page, Stack, Row, Grid, Divider, Spacer, Text, H1, H2, H3, Code, Link,
  Card, CardHeader, CardBody, Table, Button, Pill, Stat, Callout,
} from "./ui.jsx";
export { TextInput, TextArea, Checkbox, Toggle, Select, IconButton } from "./forms.jsx";
export { BarChart, LineChart, PieChart } from "./charts.jsx";
export { DiffView, DiffStats, TodoList, TodoListCard, UsageBar, Swatch, CollapsibleSection } from "./extras.jsx";
export { computeDAGLayout } from "./dag.js";
