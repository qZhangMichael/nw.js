var Binding = require('binding').Binding;
var nw_binding = require('binding').Binding.create('nw.Window');
var nwNatives = requireNative('nw_natives');
var forEach = require('utils').forEach;
var Event = require('event_bindings').Event;
var dispatchEvent = require('event_bindings').dispatchEvent;
var dispatchEventNW = require('event_bindings').dispatchEventNW;
var sendRequest = require('sendRequest');
var runtimeNatives = requireNative('runtime');
var renderFrameObserverNatives = requireNative('renderFrameObserverNatives');
var appWindowNatives = requireNative('app_window_natives');

var GetExtensionViews = runtimeNatives.GetExtensionViews;

var currentNWWindow = null;
var currentRoutingID = nwNatives.getRoutingID();
var currentWidgetRoutingID = nwNatives.getWidgetRoutingID();

var nw_internal = require('binding').Binding.create('nw.currentWindowInternal');

var bgPage = GetExtensionViews(-1, -1, 'BACKGROUND')[0];

var try_hidden = function (view) {
  if (view.chrome.windows)
    return view;
  return privates(view);
};

var try_nw = function (view) {
  if (view.nw)
    return view;
  return privates(view);
};

function getPlatform() {
  var platforms = [
    [/CrOS Touch/, "chromeos touch"],
    [/CrOS/, "chromeos"],
    [/Linux/, "linux"],
    [/Mac/, "mac"],
    [/Win/, "win"],
  ];

  for (var i = 0; i < platforms.length; i++) {
    if ($RegExp.exec(platforms[i][0], navigator.appVersion)) {
      return platforms[i][1];
    }
  }
  return "unknown";
}

var canSetVisibleOnAllWorkspaces = /(mac|linux)/.exec(getPlatform());
var appWinEventsMap = {
  'minimize':         'onMinimized',
  'maximize':         'onMaximized',
  'restore':          'onRestored',
  'enter-fullscreen': 'onFullscreened',
  'closed':           'onClosed',
  'move':             'onMoved',
  'resize':           'onResized'
};

var nwWinEventsMap = {
  'zoom':             'onZoom',
  'close':            'onClose'
};

var nwWrapEventsMap = {
  'loaded':           'LoadingStateChanged',
  'new-win-policy':   'onNewWinPolicy',
  'navigation':       'onNavigation'
};

nw_internal.registerCustomHook(function(bindingsAPI) {
  var apiFunctions = bindingsAPI.apiFunctions;
  apiFunctions.setHandleRequest('getCurrent', function() {
    return sendRequest.sendRequestSync('nw.currentWindowInternal.getCurrent', arguments, this.definition.parameters, {})[0];
  });
  apiFunctions.setHandleRequest('getZoom', function() {
    return sendRequest.sendRequestSync('nw.currentWindowInternal.getZoom', arguments, this.definition.parameters, {})[0];
  });
  apiFunctions.setHandleRequest('setZoom', function() {
    return sendRequest.sendRequestSync('nw.currentWindowInternal.setZoom', arguments, this.definition.parameters, {});
  });
  apiFunctions.setHandleRequest('getTitleInternal', function() {
    return sendRequest.sendRequestSync('nw.currentWindowInternal.getTitleInternal', arguments, this.definition.parameters, {})[0];
  });
  apiFunctions.setHandleRequest('setTitleInternal', function() {
    return sendRequest.sendRequestSync('nw.currentWindowInternal.setTitleInternal', arguments, this.definition.parameters, {});
  });
  apiFunctions.setHandleRequest('isKioskInternal', function() {
    return sendRequest.sendRequestSync('nw.currentWindowInternal.isKioskInternal', arguments, this.definition.parameters, {})[0];
  });
  apiFunctions.setHandleRequest('getWinParamInternal', function() {
    return sendRequest.sendRequestSync('nw.currentWindowInternal.getWinParamInternal', arguments, this.definition.parameters, {})[0];
  });
  apiFunctions.setHandleRequest('setPrintSettingsInternal', function() {
    return sendRequest.sendRequestSync('nw.currentWindowInternal.setPrintSettingsInternal', arguments, this.definition.parameters, {})[0];
  });
  apiFunctions.setHandleRequest('setMenu', function() {
    return sendRequest.sendRequestSync('nw.currentWindowInternal.setMenu', arguments, this.definition.parameters, {})[0];
  });
});

var currentNWWindowInternal = nw_internal.generate();

function NWWindow(cWindow) {
  if (cWindow)
    this.cWindow = cWindow;
  else {
    this.cWindow = currentNWWindowInternal.getCurrent({'populate': true});
    if (!this.cWindow)
          console.error('The JavaScript context calling ' +
                        'nw.Window.get() has no associated Browser window.');
  }
  console.log("cWindow id: " + this.cWindow.id);
  privates(this).menu = null;
}

forEach(currentNWWindowInternal, function(key, value) {
  if (!key.endsWith('Internal'))
    NWWindow.prototype[key] = value;
});

NWWindow.prototype.onNewWinPolicy      = new Event("nw.Window.onNewWinPolicy");
NWWindow.prototype.onNavigation        = new Event();
NWWindow.prototype.LoadingStateChanged = new Event();
NWWindow.prototype.onDocumentStart     = new Event("nw.Window.onDocumentStart");
NWWindow.prototype.onDocumentEnd       = new Event("nw.Window.onDocumentEnd");
NWWindow.prototype.onZoom              = new Event();
NWWindow.prototype.onClose             = new Event("nw.Window.onClose", undefined, {supportsFilters: true});

NWWindow.prototype.close = function (force) {
  currentNWWindowInternal.close(force, this.cWindow.id);
}

NWWindow.prototype.once = function (event, listener, record) {
  if (typeof listener !== 'function')
    throw new TypeError('listener must be a function');
  var fired = false;
  var self = this;

  function g() {
    self.removeListener(event, g);
    if (!fired) {
      fired = true;
      listener.apply(self, arguments);
    }
  }
  this.on(event, g, false);
  return this;
};

NWWindow.prototype.on = function (event, callback, record) {
  var self = this;

  // Wrap callback to bind to `self`.
  // If `cb` is given, use `cb` instead of original `callback`.
  function wrap(cb) {
    var fn = (cb || callback).bind(self);
    fn.listener = callback;
    return fn;
  }

  if (event === 'close') {
    this.onClose.addListener(wrap(), {instanceId: currentWidgetRoutingID});
    return this;
  }
  switch (event) {
  case 'focus':
    this.appWindow.contentWindow.onfocus = wrap();
    break;
  case 'blur':
    this.appWindow.contentWindow.onblur = wrap();
    break;
  case 'loaded':
    var g = wrap(function(tabId, changeInfo, tab) {
      if (tab.windowId !== self.cWindow.id)
        return;
      if ('status' in changeInfo && changeInfo.status == 'complete')
        callback.call(self);
    });
    chrome.tabs.onUpdated.addListener(g);
    break;
  case 'document-start':
    var cb1 = wrap(function(frame, top_routing_id) {
      console.log("document-start: cWindow: " + self.cWindow.id + "; top routing id: " + top_routing_id + "; main frame id: " + self.cWindow.tabs[0].mainFrameId);
      if (top_routing_id !== self.cWindow.tabs[0].mainFrameId)
        return;
      callback.call(self, frame);
    });
    this.onDocumentStart.addListener(cb1);
    break;
  case 'document-end':
    var cb0 = wrap(function(frame, top_routing_id) {
      console.log("document-end: cWindow: " + self.cWindow.id + "; top routing id: " + top_routing_id + "; main frame id: " + self.cWindow.tabs[0].mainFrameId);
      if (top_routing_id !== self.cWindow.tabs[0].mainFrameId)
        return;
      callback.call(self, frame);
    });
    this.onDocumentEnd.addListener(cb0);
    break;
  case 'new-win-policy':
    var h = wrap(function(frame, url, policy) {
      policy.ignore         =  function () { this.val = 'ignore'; };
      policy.forceCurrent   =  function () { this.val = 'current'; };
      policy.forceDownload  =  function () { this.val = 'download'; };
      policy.forceNewWindow =  function () { this.val = 'new-window'; };
      policy.forceNewPopup  =  function () { this.val = 'new-popup'; };
      policy.setNewWindowManifest = function (m) { this.manifest = m; };
      callback.call(self, frame, url, policy);
    });
    this.onNewWinPolicy.addListener(h);
    break;
  case 'navigation':
    var j = wrap(function(frame, url, policy, context) {
      policy.ignore         =  function () { this.val = 'ignore'; };
      callback.call(self, frame, url, policy, context);
    });
    this.onNavigation.addListener(j);
    break;
  case 'move':
    var k = wrap(function() {
      callback.call(self, self.x, self.y);
    });
    this.appWindow.onMoved.addListener(k);
    return this; //return early
    break;
  case 'resize':
    var l = wrap(function() {
      callback.call(self, self.width, self.height);
    });
    this.appWindow.onResized.addListener(l);
    return this; //return early
    break;
  }
  if (appWinEventsMap.hasOwnProperty(event)) {
    this.appWindow[appWinEventsMap[event]].addListener(wrap());
    return this;
  }
  if (nwWinEventsMap.hasOwnProperty(event)) {
    this[nwWinEventsMap[event]].addListener(wrap());
    return this;
  }
  return this;
};
NWWindow.prototype.removeListener = function (event, callback) {
  if (appWinEventsMap.hasOwnProperty(event)) {
    for (let l of this.appWindow[appWinEventsMap[event]].getListeners()) {
      if (l.callback.listener && l.callback.listener === callback) {
        this.appWindow[appWinEventsMap[event]].removeListener(l.callback);
        return this;
      }
    }
  }
  if (nwWinEventsMap.hasOwnProperty(event)) {
    for (let l of this[nwWinEventsMap[event]].getListeners()) {
      if (l.callback.listener && l.callback.listener === callback) {
        this[nwWinEventsMap[event]].removeListener(l.callback);
        return this;
      }
    }
  }
  if (nwWrapEventsMap.hasOwnProperty(event)) {
    for (let l of this[nwWrapEventsMap[event]].getListeners()) {
      if (l.callback.listener && l.callback.listener === callback) {
        this[nwWrapEventsMap[event]].removeListener(l.callback);
        return this;
      }
    }
  }
  switch (event) {
  case 'focus':
    if (this.appWindow.contentWindow.onfocus && this.appWindow.contentWindow.onfocus.listener === callback)
      this.appWindow.contentWindow.onfocus = null;
    break;
  case 'blur':
    if (this.appWindow.contentWindow.onblur && this.appWindow.contentWindow.onblur.listener === callback)
      this.appWindow.contentWindow.onblur = null;
    break;
  }
  return this;
};

NWWindow.prototype.removeAllListeners = function (event) {
  if (arguments.length === 0) {
    var obj = Object.assign({}, appWinEventsMap, nwWinEventsMap, nwWrapEventsMap);
    var keys = Object.keys(obj);
    for (var i = 0, key; i < keys.length; ++i) {
      key = keys[i];
      this.removeAllListeners(key);
    }
    return this;
  }
  if (appWinEventsMap.hasOwnProperty(event)) {
    for (let l of this.appWindow[appWinEventsMap[event]].getListeners()) {
      this.appWindow[appWinEventsMap[event]].removeListener(l.callback);
    }
    return this;
  }
  if (nwWinEventsMap.hasOwnProperty(event)) {
    for (let l of this[nwWinEventsMap[event]].getListeners()) {
      this[nwWinEventsMap[event]].removeListener(l.callback);
    }
    return this;
  }
  if (nwWrapEventsMap.hasOwnProperty(event)) {
    for (let l of this[nwWrapEventsMap[event]].getListeners()) {
      this[nwWrapEventsMap[event]].removeListener(l.callback);
    }
    return this;
  }
  switch (event) {
  case 'focus':
    this.appWindow.contentWindow.onfocus = null;
    break;
  case 'blur':
    this.appWindow.contentWindow.onblur = null;
    break;
  }
  return this;
};

NWWindow.prototype.setShadow = function(shadow) {
  currentNWWindowInternal.setShadow(shadow);
};

NWWindow.prototype.showDevTools = function(frm, callback) {
  var id = '';
  if (typeof frm === 'string')
    id = frm;
  var f = null;
  if (id)
    f = this.window.getElementById(id);
  else
    f = frm || null;
  nwNatives.setDevToolsJail(f);
  currentNWWindowInternal.showDevTools2Internal(this.cWindow.id, callback);
};
NWWindow.prototype.capturePage = function (callback, options) {
  var cb = callback;
  if (!options)
    options = {'format':'jpeg', 'datatype':'datauri'};
  if (typeof options == 'string')
    options = {'format':options, 'datatype':'datauri'};
  if (options.datatype != 'datauri') {
    cb = function (format, datauri) {
      var raw = datauri.replace(/^data:[^;]*;base64,/, '');
      switch(format){
      case 'buffer' :
        callback(new nw.Buffer(raw, "base64"));
        break;
      case 'raw' :
        callback(raw);
        break;
      }
    };
    cb = cb.bind(undefined, options.datatype);
  }
  currentNWWindowInternal.capturePageInternal(options, cb);
};
NWWindow.prototype.reload = function () {
  chrome.tabs.reload(this.cWindow.tabs[0].id);
};
NWWindow.prototype.reloadIgnoringCache = function () {
  chrome.tabs.reload(this.cWindow.tabs[0].id, {'bypassCache': true});
};
NWWindow.prototype.eval = function (frame, script) {
  return nwNatives.evalScript(frame, script);
};
NWWindow.prototype.evalNWBin = function (frame, path) {
  this.evalNWBinInternal(frame, path);
};
NWWindow.prototype.evalNWBinModule = function (frame, path, module_path) {
  this.evalNWBinInternal(frame, path, module_path);
};
NWWindow.prototype.evalNWBinInternal = function (frame, path, module_path) {
  var ab;
  if (Buffer.isBuffer(path)) {
    let buf = path;
    ab = new global.ArrayBuffer(path.length);
    path.copy(Buffer.from(ab));
  } else if ($Object.prototype.toString.apply(path) === '[object ArrayBuffer]') {
    ab = path;
  } else {
    let buf = global.require('fs').readFileSync(path);
    ab = new global.ArrayBuffer(buf.length);
    buf.copy(Buffer.from(ab));
  }
  if (module_path)
    return nwNatives.evalNWBin(frame, ab, module_path);
  return nwNatives.evalNWBin(frame, ab);
};
NWWindow.prototype.show = function () {
  this.appWindow.show();
};
NWWindow.prototype.hide = function () {
  this.appWindow.hide();
};
NWWindow.prototype.focus = function () {
  chrome.windows.update(this.cWindow.id, {'focused':true});
};
NWWindow.prototype.blur = function () {
  this.appWindow.contentWindow.blur();
};
NWWindow.prototype.minimize = function () {
  chrome.windows.update(this.cWindow.id, {'state':'minimized'});
};
NWWindow.prototype.maximize = function () {
  chrome.windows.update(this.cWindow.id, {'state':"maximized"});
};
NWWindow.prototype.unmaximize = NWWindow.prototype.restore = function () {
  chrome.windows.update(this.cWindow.id, {'state':"normal"});
};
NWWindow.prototype.enterFullscreen = function () {
  chrome.windows.update(this.cWindow.id, {'state':"fullscreen"});
};
NWWindow.prototype.leaveFullscreen = function () {
  if (this.appWindow.isFullscreen())
    this.appWindow.restore();
};
NWWindow.prototype.toggleFullscreen = function () {
  if (this.appWindow.isFullscreen())
    this.appWindow.restore();
  else
    this.appWindow.fullscreen();
};
NWWindow.prototype.setAlwaysOnTop = function (top) {
  this.appWindow.setAlwaysOnTop(top);
};
NWWindow.prototype.setPosition = function (pos) {
  if (pos == "center") {
    var screenWidth = screen.availWidth;
    var screenHeight = screen.availHeight;
    var width  = this.appWindow.outerBounds.width;
    var height = this.appWindow.outerBounds.height;
    this.appWindow.outerBounds.setPosition(Math.round((screenWidth-width)/2),
                                           Math.round((screenHeight-height)/2));
  }
};
NWWindow.prototype.setVisibleOnAllWorkspaces = function(all_visible) {
  this.appWindow.setVisibleOnAllWorkspaces(all_visible);
};
NWWindow.prototype.canSetVisibleOnAllWorkspaces = function() {
  return canSetVisibleOnAllWorkspaces;
};
NWWindow.prototype.setMaximumSize = function (width, height) {
  this.appWindow.outerBounds.maxWidth = width;
  this.appWindow.outerBounds.maxHeight = height;
};
NWWindow.prototype.setMinimumSize = function (width, height) {
  this.appWindow.outerBounds.minWidth = width;
  this.appWindow.outerBounds.minHeight = height;
};
NWWindow.prototype.resizeTo = function (width, height) {
  this.appWindow.outerBounds.width = width;
  this.appWindow.outerBounds.height = height;
};
NWWindow.prototype.resizeBy = function (width, height) {
  this.appWindow.outerBounds.width += width;
  this.appWindow.outerBounds.height += height;
};
NWWindow.prototype.moveTo = function (x, y) {
  this.appWindow.outerBounds.left = x;
  this.appWindow.outerBounds.top = y;
};
NWWindow.prototype.moveBy = function (x, y) {
  this.appWindow.outerBounds.left += x;
  this.appWindow.outerBounds.top += y;
};
NWWindow.prototype.setResizable = function (resizable) {
  this.appWindow.setResizable(resizable);
};
NWWindow.prototype.requestAttention = function (flash) {
  if (typeof flash == 'boolean')
    flash = flash ? -1 : 0;
  currentNWWindowInternal.requestAttentionInternal(flash);
};
NWWindow.prototype.cookies = chrome.cookies;

NWWindow.prototype.print = function(option) {
  var _option = JSON.parse(JSON.stringify(option));
  if (!("autoprint" in _option))
    _option["autoprint"] = true;
  if (option.pdf_path)
    _option["printer"] = "Save as PDF";
  currentNWWindowInternal.setPrintSettingsInternal(_option);
  window.print();
  // autoprint will be set to false in print_preview_handler.cc after printing is done
  // window.print will return immediately for PDF window #5002
};
Object.defineProperty(NWWindow.prototype, 'x', {
  get: function() {
    return this.cWindow.left;
  },
  set: function(x) {
    this.appWindow.outerBounds.left = x;
  }
});
Object.defineProperty(NWWindow.prototype, 'y', {
  get: function() {
    return this.cWindow.top;
  },
  set: function(y) {
    this.appWindow.outerBounds.top = y;
  }
});
Object.defineProperty(NWWindow.prototype, 'width', {
  get: function() {
    return this.cWindow.width;
  },
  set: function(val) {
    this.appWindow.innerBounds.width = val;
  }
});
Object.defineProperty(NWWindow.prototype, 'height', {
  get: function() {
    return this.cWindow.height;
  },
  set: function(val) {
    this.appWindow.innerBounds.height = val;
  }
});
Object.defineProperty(NWWindow.prototype, 'title', {
  get: function() {
    return currentNWWindowInternal.getTitleInternal();
  },
  set: function(val) {
    currentNWWindowInternal.setTitleInternal(val);
  }
});
Object.defineProperty(NWWindow.prototype, 'zoomLevel', {
  get: function() {
    return currentNWWindowInternal.getZoom();
  },
  set: function(val) {
    currentNWWindowInternal.setZoom(val);
  }
});
Object.defineProperty(NWWindow.prototype, 'isTransparent', {
  get: function() {
    return this.appWindow.alphaEnabled();
  }
});
Object.defineProperty(NWWindow.prototype, 'isKioskMode', {
  get: function() {
    return currentNWWindowInternal.isKioskInternal();
  },
  set: function(val) {
    if (val)
      currentNWWindowInternal.enterKioskMode();
    else
      currentNWWindowInternal.leaveKioskMode();
  }
});
Object.defineProperty(NWWindow.prototype, 'isFullscreen', {
  get: function() {
    return this.appWindow.isFullscreen();
  }
});
Object.defineProperty(NWWindow.prototype, 'isAlwaysOnTop', {
  get: function() {
    return this.appWindow.isAlwaysOnTop();
  }
});
Object.defineProperty(NWWindow.prototype, 'menu', {
  get: function() {
    var ret = privates(this).menu || {};
    return ret;
  },
  set: function(menu) {
    if(!menu) {
      privates(this).menu = null;
      currentNWWindowInternal.clearMenu();
      return;
    }
    if (menu.type != 'menubar')
      throw new TypeError('Only menu of type "menubar" can be used as this.window menu');

    privates(this).menu =  menu;
    var menuPatch = currentNWWindowInternal.setMenu(menu.id);
    if (menuPatch.length) {
      menuPatch.forEach((patch)=>{
        let menuIndex = patch.menu;
        let itemIndex = patch.index;
        let menuToPatch = menu.items[menuIndex];
        if (menuToPatch && menuToPatch.submenu) {
          menuToPatch.submenu.insert(new nw.MenuItem(patch.option), itemIndex);
        }
      });
    }
  }
});
Object.defineProperty(NWWindow.prototype, 'window', {
  get: function() {
    return appWindowNatives.GetFrame(this.cWindow.tabs[0].mainFrameId, false);
  }
});
Object.defineProperty(NWWindow.prototype, 'frameId', {
  get: function() {
    return currentRoutingID;
  }
});

nw_binding.registerCustomHook(function(bindingsAPI) {
  var apiFunctions = bindingsAPI.apiFunctions;
  apiFunctions.setHandleRequest('get', function(domWindow) {
    if (domWindow)
      return try_nw(domWindow.top).nw.Window.get();
    if (currentNWWindow)
      return currentNWWindow;

    currentNWWindow = new NWWindow;
    return currentNWWindow;
  });

  apiFunctions.setHandleRequest('open', function(url, params, callback) {
    var options = {'url': url, 'setSelfAsOpener': true};
    //FIXME: unify this conversion code with nwjs/default.js
    //options.innerBounds = {};
    //options.outerBounds = {};
    if (params) {
      if (params.frame === false)
        options.frameless = true;
      // if (params.resizable === false)
      //   options.resizable = false;
      // if (params.focus === false)
      //   options.focused = false;
      // if (params.x)
      //   options.outerBounds.left = params.x;
      // if (params.y)
      //   options.outerBounds.top = params.y;
      if (params.height)
        options.height = params.height;
      if (params.width)
        options.width = params.width;
      // if (params.min_width)
      //   options.innerBounds.minWidth = params.min_width;
      // if (params.max_width)
      //   options.innerBounds.maxWidth = params.max_width;
      // if (params.min_height)
      //   options.innerBounds.minHeight = params.min_height;
      // if (params.max_height)
      //   options.innerBounds.maxHeight = params.max_height;
      // if (params.fullscreen === true)
      //   options.state = 'fullscreen';
      if (params.show === false)
        options.hidden = true;
      // if (params.show_in_taskbar === false)
      //   options.show_in_taskbar = false;
      // if (params['always_on_top'] === true)
      //   options.alwaysOnTop = true;
      // if (params['visible_on_all_workspaces'] === true)
      //   options.visibleOnAllWorkspaces = true;
      if (typeof params['inject_js_start'] == 'string')
         options.inject_js_start = params['inject_js_start'];
      if (typeof params['inject_js_end'] == 'string')
         options.inject_js_end = params['inject_js_end'];
      // if (params.transparent)
      //   options.alphaEnabled = true;
      // if (params.kiosk === true)
      //   options.kiosk = true;
      if (params.new_instance === true) {
        options.new_instance = true;
        options.setSelfAsOpener = false;
      }
      // if (params.position)
      //   options.position = params.position;
      // if (params.title)
      //   options.title = params.title;
      // if (params.icon)
      //   options.icon = params.icon;
      //if (params.id)
      //  options.tabId = params.id;
    }
    try_hidden(window).chrome.windows.create(options, function(cWin) {
      if (callback) {
        if (cWin)
          callback(new NWWindow(cWin));
        else
          callback();
      }
    });
  });

});

function dispatchEventIfExists(target, name, varargs) {
  // Sometimes apps like to put their own properties on the window which
  // break our assumptions.
  var event = target[name];
  if (event && (typeof event.dispatch == 'function'))
    $Function.apply(event.dispatch, event, varargs);
  else
    console.warn('Could not dispatch ' + name + ', event has been clobbered');
}

function onNewWinPolicy(frame, url, policy) {
  //console.log("onNewWinPolicy called: " + url + ", " + policy);
  dispatchEventNW("nw.Window.onNewWinPolicy", [frame, url, policy]);
}

function onNavigation(frame, url, policy, context) {
  //console.log("onNavigation called: " + url + ", " + context);
  if (!currentNWWindow)
    return;
  dispatchEventIfExists(currentNWWindow, "onNavigation", [frame, url, policy, context]);
}

function onLoadingStateChanged(status) {
  //console.log("onLoadingStateChanged: " + status);
  if (!currentNWWindow)
    return;
  dispatchEventIfExists(currentNWWindow, "LoadingStateChanged", [status]);
}

function onDocumentStartEnd(start, frame, top_routing_id) {
  console.log("--> onDocumentStartEnd: " + start + "; currentNWWindow: " + currentNWWindow);
  if (start) {
    //could use the non-NW version?
    dispatchEventNW("nw.Window.onDocumentStart", [frame, top_routing_id]);
  }
  else
    dispatchEventNW("nw.Window.onDocumentEnd", [frame, top_routing_id]);
}

function updateAppWindowZoom(old_level, new_level) {
  if (!currentNWWindow)
    return;
  dispatchEventIfExists(currentNWWindow, "onZoom", [new_level]);
}

function onClose(user_force) {
  if (!currentNWWindow)
    return;
  dispatchEventNW("nw.Window.onClose", [user_force], {instanceId: currentWidgetRoutingID});
}

function get_nw() {
  console.log("--> get_nw");
  appWindowNatives.FixGamePadAPI();
  var nw0 = try_nw(window).nw;
  if (nw0)
    nw0.Window.get();
}

//if (bgPage !== window) {
//  renderFrameObserverNatives.OnDocumentElementCreated(currentRoutingID, get_nw);
//}

exports.binding = nw_binding.generate();
exports.onNewWinPolicy = onNewWinPolicy;
exports.onNavigation = onNavigation;
exports.LoadingStateChanged = onLoadingStateChanged;
exports.onDocumentStartEnd = onDocumentStartEnd;
exports.onClose = onClose;
exports.updateAppWindowZoom = updateAppWindowZoom;
