// Local stand-in for the design canvas runtime (support.js), so the canvas
// sources in docs/redesign/screens/*.dc.html render in a browser for review.
// Served by scripts/redesign-preview.mjs; not part of any app.
//
// Covers what the 64 screens use: {{path}} holes in text and attributes,
// <sc-if>, <sc-for as>, <dc-import> with props, <helmet>, on* handlers,
// setState, componentDidMount and data-props defaults. The template is parsed
// as XML so <sc-for> inside <tbody> keeps its place (an HTML parser would move
// it out of the table). Top-level props can be set in the query string, for
// example PhoneOrder.dc.html?guest=true.
(function () {
  "use strict";
  var SVG = "http://www.w3.org/2000/svg";
  var VOID = ["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"];
  var files = {};

  var hide = document.createElement("style");
  hide.textContent = "x-dc,script[data-dc-script]{display:none!important}";
  document.head.appendChild(hide);

  function DCLogic(props) { this.props = props || {}; this.state = {}; }
  DCLogic.prototype.renderVals = function () { return {}; };
  DCLogic.prototype.setState = function (patch) {
    var next = typeof patch === "function" ? patch(this.state, this.props) : patch;
    this.state = Object.assign({}, this.state, next);
    if (this.__render) this.__render();
  };
  window.DCLogic = DCLogic;

  // Closes void tags and gives bare attributes a value, so the markup is XML.
  function xmlify(html) {
    return html.replace(/<([a-zA-Z][\w-]*)((?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)>/g, function (all, tag, attrs, close) {
      var fixed = attrs.replace(/\s+([^\s=>\/]+)(\s*=\s*(?:"[^"]*"|'[^']*'))?/g, function (one, name, value) { return value ? one : " " + name + '=""'; });
      return "<" + tag + fixed + (close || VOID.indexOf(tag.toLowerCase()) >= 0 ? "/" : "") + ">";
    });
  }

  function parse(source) {
    var start = source.indexOf("<x-dc>"), end = source.indexOf("</x-dc>");
    var doc = new DOMParser().parseFromString(xmlify(source.slice(start, end + 7)), "application/xml");
    var error = doc.getElementsByTagName("parsererror")[0];
    if (error) throw new Error("Canvas template could not be parsed: " + error.textContent);
    var script = /<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/.exec(source);
    var meta = /data-props='([^']*)'/.exec(source), defaults = {};
    try {
      var props = JSON.parse(meta ? meta[1] : "{}");
      // Own properties only (Object.fromEntries), so no key can reach a prototype.
      defaults = Object.fromEntries(Object.keys(props).filter(function (key) { return key.charAt(0) !== "$" && props[key] && "default" in props[key]; })
        .map(function (key) { return [key, props[key].default]; }));
    } catch (ignore) { /* No defaults. */ }
    // The class body is the canvas file's own code, run like the real runtime does.
    var Component = script ? new Function("DCLogic", script[1] + "\nreturn Component;")(DCLogic) : DCLogic;
    return { root: doc.documentElement, Component: Component, defaults: defaults, helmet: false };
  }

  function load(url) {
    if (!files[url]) {
      files[url] = fetch(url).then(function (response) { return response.text(); }).then(function (source) {
        var file = parse(source);
        var names = [].map.call(file.root.getElementsByTagName("dc-import"), function (el) { return el.getAttribute("name") + ".dc.html"; });
        return Promise.all(names.map(load)).then(function () { return file; });
      });
    }
    return files[url];
  }

  function literal(expr) {
    if (expr === "true") return { value: true };
    if (expr === "false") return { value: false };
    if (expr === "null") return { value: null };
    if (/^-?\d+(\.\d+)?$/.test(expr)) return { value: Number(expr) };
    if (/^(['"]).*\1$/.test(expr)) return { value: expr.slice(1, -1) };
    return null;
  }

  function lookup(expr, scopes) {
    var fixed = literal(expr);
    if (fixed) return fixed.value;
    var parts = expr.split("."), head = parts.shift();
    for (var i = 0; i < scopes.length; i++) {
      if (scopes[i] && Object.prototype.hasOwnProperty.call(scopes[i], head)) {
        return parts.reduce(function (value, key) { return value == null ? undefined : value[key]; }, scopes[i][head]);
      }
    }
    return undefined;
  }

  var WHOLE = /^\{\{\s*([^}]*?)\s*\}\}$/;
  function evaluate(text, scopes) {
    var whole = WHOLE.exec(text);
    if (whole) return lookup(whole[1], scopes);
    return text.replace(/\{\{\s*([^}]*?)\s*\}\}/g, function (all, expr) { var value = lookup(expr, scopes); return value == null ? "" : String(value); });
  }

  function renderChildren(node, scopes, parent, file, svg) {
    for (var child = node.firstChild; child; child = child.nextSibling) renderNode(child, scopes, parent, file, svg);
  }

  function renderNode(node, scopes, parent, file, svg) {
    if (node.nodeType === 3) { parent.appendChild(document.createTextNode(evaluate(node.nodeValue, scopes))); return; }
    if (node.nodeType !== 1) return;
    var tag = node.nodeName;
    if (tag === "helmet") {
      if (!file.helmet) { file.helmet = true; renderChildren(node, scopes, document.head, file, false); }
      return;
    }
    if (tag === "sc-if") { if (evaluate(node.getAttribute("value") || "", scopes)) renderChildren(node, scopes, parent, file, svg); return; }
    if (tag === "sc-for") {
      var list = evaluate(node.getAttribute("list") || "", scopes) || [], as = node.getAttribute("as") || "item";
      [].forEach.call(list, function (item, index) { var scope = { index: index }; scope[as] = item; renderChildren(node, [scope].concat(scopes), parent, file, svg); });
      return;
    }
    if (tag === "dc-import") {
      var props = {}, host = document.createElement("div");
      [].forEach.call(node.attributes, function (attr) { if (attr.name !== "name" && attr.name.indexOf("hint-") !== 0) props[attr.name] = evaluate(attr.value, scopes); });
      host.style.display = "contents";
      parent.appendChild(host);
      load(node.getAttribute("name") + ".dc.html").then(function (child) { mount(child, props, host); });
      return;
    }
    var inSvg = svg || tag === "svg";
    var el = inSvg ? document.createElementNS(SVG, tag) : document.createElement(tag);
    [].forEach.call(node.attributes, function (attr) {
      if (attr.name.indexOf("hint-") === 0) return;
      var value = evaluate(attr.value, scopes);
      if (/^on[A-Z]/.test(attr.name)) { if (typeof value === "function") el.addEventListener(attr.name.slice(2).toLowerCase(), value); return; }
      if (value === false || value == null) return;
      el.setAttribute(attr.name, value === true ? "" : String(value));
    });
    renderChildren(node, scopes, el, file, inSvg && tag !== "foreignObject");
    parent.appendChild(el);
  }

  function mount(file, props, host) {
    var instance = new file.Component(Object.assign({}, file.defaults, props));
    instance.__render = function () {
      host.textContent = "";
      renderChildren(file.root, [instance.renderVals() || {}], host, file, false);
    };
    instance.__render();
    if (typeof instance.componentDidMount === "function") instance.componentDidMount();
  }

  function start() {
    // Props in the address (PhoneOrder.dc.html?guest=true) become own properties
    // only: a "__proto__" or "constructor" key cannot reach a prototype.
    var props = Object.fromEntries(Array.from(new URLSearchParams(location.search), function (pair) {
      var value = pair[1];
      return [pair[0], value === "true" ? true : value === "false" ? false : value];
    }));
    var host = document.createElement("div");
    host.id = "dc-root";
    document.body.appendChild(host);
    load(location.pathname).then(function (file) { mount(file, props, host); document.documentElement.setAttribute("data-dc-ready", ""); })
      .catch(function (error) { host.textContent = String(error); document.documentElement.setAttribute("data-dc-ready", "error"); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
