// Mounts a compiled canvas module into #root, inside the sandboxed canvas frame.
import { Component, StrictMode, createElement } from "react";
import { createRoot } from "react-dom/client";

function showError(error) {
  const root = document.getElementById("root");
  const box = document.createElement("div");
  box.id = "rk-canvas-error";
  box.textContent = `画布运行出错：${error?.message ?? String(error)}`;
  root.replaceChildren(box);
}

class Boundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) {
      return createElement("div", { id: "rk-canvas-error" }, `画布运行出错：${this.state.error?.message ?? String(this.state.error)}`);
    }
    return this.props.children;
  }
}

export function mountCanvas(mod) {
  const App = mod?.default;
  if (typeof App !== "function" && typeof App !== "object") {
    showError(new Error("画布没有默认导出的组件。"));
    return;
  }
  try {
    createRoot(document.getElementById("root")).render(
      createElement(StrictMode, null, createElement(Boundary, null, createElement(App))),
    );
  } catch (error) {
    showError(error);
  }
}
