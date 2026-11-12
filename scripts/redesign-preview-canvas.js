// Local stand-in for the design canvas runtime (support.js), so the canvas
// sources in docs/redesign/screens/*.dc.html render in a browser for review.
// Served by scripts/redesign-preview.mjs; not part of any app.
//
// Covers what the 63 artboards use: {{path}} holes in text and attributes,
// <sc-if>, <sc-for as>, <dc-import> with props, <helmet>, on* handlers,
// setState, componentDidMount and data-props defaults. The template is parsed
// as XML so <sc-for> inside <tbody> keeps its place (an HTML parser would move
// it out of the table). Top-level props can be set in the query string, for
// example PhoneOrder.dc.html?guest=true.
//
// Readiness: <html data-dc-ready=""> is set only once every nested
// <dc-import> has mounted and the short timers the screens start (for example
// PhoneScanConnect's "checking" step) have fired. A failure anywhere sets
// data-dc-ready="error" and data-dc-error, so captures never mistake a broken
// render for the design; so do uncaught script errors and unhandled promise
// rejections before ready, and a root that rendered no elements. data-dc-settled="timeout" marks a screen that kept
// starting timers past the settle limit.
//
// The pure helpers are exposed as window.__ndahiCanvas for the unit tests,
// which load this file without a DOM.
(function (root) {
  "use strict";
  var SVG = "http://www.w3.org/2000/svg";
  var VOID = ["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"];
  // Never read or written from template paths or the query string.
  var UNSAFE = ["__proto__", "prototype", "constructor"];
  var TIMER_LIMIT = 5000, SETTLE_LIMIT = 8000;
  var own = function (object, key) { return Object.prototype.hasOwnProperty.call(object, key); };

  // Closes void tags and gives bare attributes a value, so the markup is XML.
  function xmlify(html) {
    return html.replace(/<([a-zA-Z][\w-]*)((?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)>/g, function (all, tag, attrs, close) {
      var fixed = attrs.replace(/\s+([^\s=>\/]+)(\s*=\s*(?:"[^"]*"|'[^']*'))?/g, function (one, name, value) { return value ? one : " " + name + '=""'; });
      return "<" + tag + fixed + (close || VOID.indexOf(tag.toLowerCase()) >= 0 ? "/" : "") + ">";
    });
  }

  function literal(expr) {
    if (expr === "true") return { value: true };
    if (expr === "false") return { value: false };
    if (expr === "null") return { value: null };
    if (/^-?\d+(\.\d+)?$/.test(expr)) return { value: Number(expr) };
    if (/^(['"]).*\1$/.test(expr)) return { value: expr.slice(1, -1) };
    return null;
  }

  // A dotted path through the scopes (innermost first). Only a scope's own
  // keys start a path, and no step walks into a prototype.
  function lookup(expr, scopes) {
    var fixed = literal(expr);
    if (fixed) return fixed.value;
    var parts = expr.split("."), head = parts.shift();
    if (UNSAFE.indexOf(head) >= 0) return undefined;
    for (var i = 0; i < scopes.length; i++) {
      if (scopes[i] && typeof scopes[i] === "object" && own(scopes[i], head)) {
        return parts.reduce(function (value, key) {
          return value == null || UNSAFE.indexOf(key) >= 0 ? undefined : value[key];
        }, scopes[i][head]);
      }
    }
    return undefined;
  }

  var WHOLE = /^\{\{\s*([^}]*?)\s*\}\}$/;
  function evaluate(text, scopes) {
    var whole = WHOLE.exec(text);
    if (whole) return lookup(whole[1], scopes);
    return text.replace(/\{\{\s*([^}]*?)\s*\}\}/g, function (all, expr) { return textOf(lookup(expr, scopes)); });
  }

  // What a template hole shows as text: nothing for null, undefined or false
  // (as the canvas runtime does), otherwise the value as a string (0 stays "0").
  function textOf(value) {
    return value == null || value === false ? "" : String(value);
  }

  // Top-level props from the address. "true"/"false" become booleans; keys
  // that could reach a prototype, and canvas-only $ keys, are ignored.
  function queryProps(search) {
    var props = {};
    new URLSearchParams(search || "").forEach(function (value, key) {
      if (UNSAFE.indexOf(key) >= 0 || key.charAt(0) === "$") return;
      props[key] = value === "true" ? true : value === "false" ? false : value;
    });
    return props;
  }

  // Defaults overlaid with props, copying only safe own keys.
  function mergeProps(defaults, props) {
    var merged = {};
    [defaults, props].forEach(function (source) {
      if (!source) return;
      Object.keys(source).forEach(function (key) { if (UNSAFE.indexOf(key) < 0) merged[key] = source[key]; });
    });
    return merged;
  }

  function propDefaults(json) {
    var defaults = {};
    var props = JSON.parse(json || "{}");
    Object.keys(props).forEach(function (key) {
      if (key.charAt(0) !== "$" && UNSAFE.indexOf(key) < 0 && props[key] && typeof props[key] === "object" && own(props[key], "default")) defaults[key] = props[key].default;
    });
    return defaults;
  }

  var helpers = { xmlify: xmlify, literal: literal, lookup: lookup, evaluate: evaluate, textOf: textOf, queryProps: queryProps, mergeProps: mergeProps, propDefaults: propDefaults };
  if (root) root.__ndahiCanvas = helpers;
  if (!root || typeof document === "undefined" || !document.head) return;

  var files = {}, busy = 0, failures = [], finished = false;
  var nativeSetTimeout = root.setTimeout.bind(root), nativeClearTimeout = root.clearTimeout.bind(root);
  var timers = {}, timerCount = 0;

  function fail(error) { if (!finished) failures.push(error instanceof Error ? error : new Error(String(error))); }
  // Script errors and rejected promises outside the tracked render (for example
  // in a screen's own async code) also keep the artboard from counting as ready.
  // Resource errors (a missing image) don't bubble to window and are not counted.
  root.addEventListener("error", function (event) { fail(event.error || event.message || "script error"); });
  root.addEventListener("unhandledrejection", function (event) { fail(event.reason || "unhandled promise rejection"); });

  // Short timers started by screen code (state steps) are awaited before the
  // screen counts as ready; longer ones are left alone.
  root.setTimeout = function (fn, delay) {
    var args = [].slice.call(arguments, 2), wait = Number(delay) || 0;
    if (typeof fn !== "function" || wait > TIMER_LIMIT) return nativeSetTimeout.apply(null, arguments);
    var id = nativeSetTimeout(function () {
      if (own(timers, id)) { delete timers[id]; timerCount--; }
      try { fn.apply(null, args); } catch (error) { fail(error); }
    }, wait);
    timers[id] = true; timerCount++;
    return id;
  };
  root.clearTimeout = function (id) {
    if (own(timers, id)) { delete timers[id]; timerCount--; }
    nativeClearTimeout(id);
  };

  function track(promise) {
    busy++;
    return promise.then(function (value) { busy--; return value; }, function (error) { busy--; fail(error); throw error; });
  }

  var hide = document.createElement("style");
  hide.textContent = "x-dc,script[data-dc-script]{display:none!important}";
  document.head.appendChild(hide);

  function DCLogic(props) { this.props = props || {}; this.state = {}; }
  DCLogic.prototype.renderVals = function () { return {}; };
  DCLogic.prototype.setState = function (patch) {
    var next = typeof patch === "function" ? patch(this.state, this.props) : patch;
    this.state = Object.assign({}, this.state, next);
    if (this.__render) this.__render().catch(function () { /* Recorded by track(). */ });
  };
  root.DCLogic = DCLogic;

  function parse(source, url) {
    var start = source.indexOf("<x-dc>"), end = source.indexOf("</x-dc>");
    if (start < 0 || end < start) throw new Error(url + " has no <x-dc> template");
    var doc = new DOMParser().parseFromString(xmlify(source.slice(start, end + 7)), "application/xml");
    var error = doc.getElementsByTagName("parsererror")[0];
    if (error) throw new Error(url + ": template could not be parsed: " + error.textContent);
    var script = /<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/.exec(source);
    var meta = /data-props='([^']*)'/.exec(source), defaults;
    try { defaults = propDefaults(meta ? meta[1] : "{}"); }
    catch (cause) { throw new Error(url + ": data-props is not valid JSON"); }
    // The class body is the canvas file's own code, run like the real runtime does.
    var Component = script ? new Function("DCLogic", script[1] + "\nreturn Component;")(DCLogic) : DCLogic;
    return { root: doc.documentElement, Component: Component, defaults: defaults, helmet: false };
  }

  function load(url) {
    if (!files[url]) {
      files[url] = fetch(url).then(function (response) {
        if (!response.ok) throw new Error("Could not load " + url + " (" + response.status + ")");
        return response.text();
      }).then(function (source) {
        var file = parse(source, url);
        var names = [].map.call(file.root.getElementsByTagName("dc-import"), function (el) { return el.getAttribute("name") + ".dc.html"; });
        return Promise.all(names.map(load)).then(function () { return file; });
      });
    }
    return files[url];
  }

  function renderChildren(node, scopes, parent, file, svg, pending) {
    for (var child = node.firstChild; child; child = child.nextSibling) renderNode(child, scopes, parent, file, svg, pending);
  }

  function renderNode(node, scopes, parent, file, svg, pending) {
    if (node.nodeType === 3) { parent.appendChild(document.createTextNode(textOf(evaluate(node.nodeValue, scopes)))); return; }
    if (node.nodeType !== 1) return;
    var tag = node.nodeName;
    if (tag === "helmet") {
      if (!file.helmet) { file.helmet = true; renderChildren(node, scopes, document.head, file, false, pending); }
      return;
    }
    if (tag === "sc-if") { if (evaluate(node.getAttribute("value") || "", scopes)) renderChildren(node, scopes, parent, file, svg, pending); return; }
    if (tag === "sc-for") {
      var list = evaluate(node.getAttribute("list") || "", scopes) || [], as = node.getAttribute("as") || "item";
      [].forEach.call(list, function (item, index) { var scope = { index: index }; scope[as] = item; renderChildren(node, [scope].concat(scopes), parent, file, svg, pending); });
      return;
    }
    if (tag === "dc-import") {
      var props = {}, host = document.createElement("div"), name = node.getAttribute("name");
      [].forEach.call(node.attributes, function (attr) {
        if (attr.name !== "name" && attr.name.indexOf("hint-") !== 0 && UNSAFE.indexOf(attr.name) < 0) props[attr.name] = evaluate(attr.value, scopes);
      });
      host.style.display = "contents";
      host.setAttribute("data-dc-import", name);
      parent.appendChild(host);
      pending.push(load(name + ".dc.html").then(function (child) { return mount(child, props, host); }));
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
    renderChildren(node, scopes, el, file, inSvg && tag !== "foreignObject", pending);
    parent.appendChild(el);
  }

  // Resolves once this screen and every screen it imports have rendered and
  // componentDidMount has run.
  function mount(file, props, host) {
    var instance = new file.Component(mergeProps(file.defaults, props));
    instance.__render = function () {
      var pending = [];
      host.textContent = "";
      renderChildren(file.root, [instance.renderVals() || {}], host, file, false, pending);
      return track(Promise.all(pending));
    };
    return instance.__render().then(function () {
      if (typeof instance.componentDidMount === "function") instance.componentDidMount();
    });
  }

  function settled(started) {
    return new Promise(function (resolve) {
      (function check() {
        if (!busy && !timerCount) return resolve(true);
        if (Date.now() - started > SETTLE_LIMIT) return resolve(false);
        nativeSetTimeout(check, 50);
      })();
    });
  }

  function start() {
    var html = document.documentElement, host = document.createElement("div");
    host.id = "dc-root";
    document.body.appendChild(host);
    load(location.pathname)
      .then(function (file) { return mount(file, queryProps(location.search), host); })
      .then(function () { return settled(Date.now()); })
      .then(function (quiet) {
        if (failures.length) throw failures[0];
        if (!host.childElementCount) throw new Error(location.pathname + " rendered nothing");
        finished = true;
        html.setAttribute("data-dc-settled", quiet ? "yes" : "timeout");
        html.setAttribute("data-dc-ready", "");
      })
      .catch(function (error) {
        finished = true;
        var message = String((failures[0] || error) && (failures[0] || error).message || error);
        host.textContent = "Canvas render failed: " + message;
        html.setAttribute("data-dc-error", message.slice(0, 500));
        html.setAttribute("data-dc-ready", "error");
      });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})(typeof window !== "undefined" ? window : null);
