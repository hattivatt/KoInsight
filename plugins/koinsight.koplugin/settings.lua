local _ = require("gettext")
local BD = require("ui/bidi")
local DataStorage = require("datastorage")
local InfoMessage = require("ui/widget/infomessage")
local logger = require("logger")
local LuaSettings = require("luasettings")
local MultiInputDialog = require("ui/widget/multiinputdialog")
local UIManager = require("ui/uimanager")
local Menu = require("ui/widget/menu")

local KoInsightSettings = {
  settings = nil, -- LuaSettings handle
  data = nil, -- in-memory normalized table
}
KoInsightSettings.__index = KoInsightSettings

local SETTING_KEY = "koinsight"
local DEFAULTS = {
  server_url = "",
  sync_on_suspend = true,
  sync_on_exit = true,
  aggressive_suspend_sync = false,
  suspend_connect_timeout_s = 10, -- clamped to [3, 60]
  basic_auth_user = "",
  basic_auth_password = "",
}

local function open_settings_handle()
  local path = DataStorage:getSettingsDir() .. "/" .. SETTING_KEY .. ".lua"
  return LuaSettings:open(path)
end

-- small helper function to clamp numeric values, e.g. timeout
local function clamp(v, lo, hi)
  if v < lo then
    return lo
  end
  if v > hi then
    return hi
  end
  return v
end

-- RFC 4648 base64, needed to build the "Basic" Authorization header.
local B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
local b64_chars = {}
for i = 1, #B64_ALPHABET do
  b64_chars[i - 1] = B64_ALPHABET:sub(i, i)
end

local function base64_encode(data)
  local out = {}
  local out_idx = 0
  for i = 1, #data, 3 do
    local b1 = data:byte(i)
    local b2 = data:byte(i + 1)
    local b3 = data:byte(i + 2)
    out_idx = out_idx + 1
    out[out_idx] = b64_chars[math.floor(b1 / 4)]
    out_idx = out_idx + 1
    out[out_idx] = b64_chars[(b1 % 4) * 16 + math.floor((b2 or 0) / 16)]
    out_idx = out_idx + 1
    out[out_idx] = b2 and b64_chars[(b2 % 16) * 4 + math.floor((b3 or 0) / 64)] or "="
    out_idx = out_idx + 1
    out[out_idx] = b3 and b64_chars[b3 % 64] or "="
  end
  return table.concat(out)
end

function KoInsightSettings:new()
  local obj = setmetatable({}, self)
  obj.settings = open_settings_handle()
  -- Safe initialization with error handling
  local success, result = pcall(function()
    return obj.settings:readSetting(SETTING_KEY, {}) or {}
  end)
  if success then
    obj.data = result
  else
    logger.err("[KoInsight] Error reading settings, using defaults:", result)
    obj.data = {}
  end
  return obj
end

-- optional for now, if we ever want to re-read from disk
function KoInsightSettings:reload()
  local success, result = pcall(function()
    return self.settings:readSetting(SETTING_KEY, {}) or {}
  end)
  if success then
    self.data = result
  else
    logger.err("[KoInsight] Error reloading settings:", result)
  end
end

function KoInsightSettings:writeData()
  local success, error_msg = pcall(function()
    if not self.settings then
      logger.err("[KoInsight] No settings object available for write")
      return false
    end
    -- Never leak the password into the debug log; keep self.data intact.
    local log_data = {}
    for k, v in pairs(self.data) do
      log_data[k] = k == "basic_auth_password" and "<redacted>" or v
    end
    logger.dbg("[KoInsight] Saving settings data:", log_data)
    self.settings:saveSetting(SETTING_KEY, self.data)
    self.settings:flush()
    logger.dbg("[KoInsight] Settings saved and flushed successfully")
    return true
  end)

  if not success then
    logger.err("[KoInsight] Error writing settings:", error_msg)
    return false
  end
  return true
end

function KoInsightSettings:update(patch)
  for k, v in pairs(patch or {}) do
    local log_value = k == "basic_auth_password" and "<redacted>" or v
    logger.dbg("[KoInsight] Updating setting:", k, "=", log_value)
    self.data[k] = v
  end
  return self:writeData()
end

-- getters/setters
function KoInsightSettings:getServerURL()
  return self.data.server_url or DEFAULTS.server_url
end
function KoInsightSettings:setServerURL(url)
  url = tostring(url or ""):gsub("/*$", "")
  self:update({ server_url = url })
end

function KoInsightSettings:getSyncOnSuspendEnabled()
  local value = self.data.sync_on_suspend
  if value == nil then
    logger.dbg("[KoInsight] sync_on_suspend not set, using default:", DEFAULTS.sync_on_suspend)
    return DEFAULTS.sync_on_suspend
  end
  return value
end
function KoInsightSettings:setSyncOnSuspendEnabled(enabled)
  return self:update({ sync_on_suspend = (enabled == true) })
end
function KoInsightSettings:toggleSyncOnSuspend()
  local current = self:getSyncOnSuspendEnabled()
  local new_value = not current
  local success = self:setSyncOnSuspendEnabled(new_value)

  if success then
    local message = new_value and _("Sync on suspend enabled") or _("Sync on suspend disabled")
    UIManager:show(InfoMessage:new({ text = message, timeout = 2 }))
    logger.info("[KoInsight] Sync on suspend toggled from", current, "to", new_value)
  else
    UIManager:show(InfoMessage:new({ text = _("Error toggling sync setting"), timeout = 3 }))
    logger.err("[KoInsight] Failed to toggle sync_on_suspend")
  end

  return success
end

function KoInsightSettings:getSyncOnExitEnabled()
  local value = self.data.sync_on_exit
  if value == nil then
    logger.dbg("[KoInsight] sync_on_exit not set, using default:", DEFAULTS.sync_on_exit)
    return DEFAULTS.sync_on_exit
  end
  return value
end
function KoInsightSettings:setSyncOnExitEnabled(enabled)
  return self:update({ sync_on_exit = (enabled == true) })
end
function KoInsightSettings:toggleSyncOnExit()
  local current = self:getSyncOnExitEnabled()
  local new_value = not current
  local success = self:setSyncOnExitEnabled(new_value)

  if success then
    local message = new_value and _("Sync on exit enabled") or _("Sync on exit disabled")
    UIManager:show(InfoMessage:new({ text = message, timeout = 2 }))
    logger.info("[KoInsight] Sync on exit toggled from", current, "to", new_value)
  else
    UIManager:show(InfoMessage:new({ text = _("Error toggling sync setting"), timeout = 3 }))
    logger.err("[KoInsight] Failed to toggle sync_on_exit")
  end

  return success
end

function KoInsightSettings:getAggressiveSuspendEnabled()
  local value = self.data.aggressive_suspend_sync
  if value == nil then
    logger.dbg(
      "[KoInsight] aggressive_suspend_sync not set, using default:",
      DEFAULTS.aggressive_suspend_sync
    )
    return DEFAULTS.aggressive_suspend_sync
  end
  return value
end
function KoInsightSettings:setAggressiveSuspendEnabled(enabled)
  return self:update({ aggressive_suspend_sync = (enabled == true) })
end
function KoInsightSettings:toggleAggressiveSuspend()
  local current = self:getAggressiveSuspendEnabled()
  local new_value = not current
  local success = self:setAggressiveSuspendEnabled(new_value)

  if success then
    local message = new_value and _("Aggressive suspend sync enabled")
      or _("Aggressive suspend sync disabled")
    UIManager:show(InfoMessage:new({ text = message, timeout = 2 }))
    logger.info("[KoInsight] Aggressive suspend sync toggled from", current, "to", new_value)
  else
    UIManager:show(
      InfoMessage:new({ text = _("Error toggling aggressive sync setting"), timeout = 3 })
    )
    logger.err("[KoInsight] Failed to toggle aggressive_suspend_sync")
  end

  return success
end

function KoInsightSettings:getSuspendConnectTimeout()
  local t = tonumber(self.data.suspend_connect_timeout_s)
  -- if it's an actual number, not nan
  if not (t and t == t) then
    logger.dbg(
      "[KoInsight] suspend_connect_timeout_s not valid, using default:",
      DEFAULTS.suspend_connect_timeout_s
    )
    return DEFAULTS.suspend_connect_timeout_s
  end
  return clamp(t, 3, 60)
end
function KoInsightSettings:setSuspendConnectTimeout(sec)
  local t = tonumber(sec)
  -- if it's an actual number, not nan
  if not (t and t == t) then
    logger.warn("[KoInsight] Invalid timeout value, using default:", sec)
    t = DEFAULTS.suspend_connect_timeout_s
  end
  t = clamp(t, 3, 60)
  return self:update({ suspend_connect_timeout_s = t })
end

-- Credentials for HTTP Basic auth, for KoInsight instances hidden behind a
-- reverse proxy that asks for it. Without a user name nothing is sent.
function KoInsightSettings:getBasicAuthUser()
  return self.data.basic_auth_user or DEFAULTS.basic_auth_user
end

function KoInsightSettings:getBasicAuthPassword()
  return self.data.basic_auth_password or DEFAULTS.basic_auth_password
end

function KoInsightSettings:setBasicAuth(user, password)
  return self:update({
    basic_auth_user = tostring(user or ""),
    basic_auth_password = tostring(password or ""),
  })
end

-- Returns the value for an HTTP "Authorization" header, or nil when no
-- credentials are configured.
function KoInsightSettings:getBasicAuthHeader()
  local user = self:getBasicAuthUser()
  if user == "" then
    return nil
  end
  return "Basic " .. base64_encode(user .. ":" .. self:getBasicAuthPassword())
end

function KoInsightSettings:editBasicAuthDialog()
  self.basic_auth_dialog = MultiInputDialog:new({
    title = _("KoInsight credentials"),
    fields = {
      {
        text = self:getBasicAuthUser(),
        description = _("User name:"),
        hint = _("empty to disable"),
      },
      {
        text = self:getBasicAuthPassword(),
        description = _("Password:"),
        text_type = "password",
      },
    },
    buttons = {
      {
        {
          text = _("Cancel"),
          id = "close",
          callback = function()
            UIManager:close(self.basic_auth_dialog)
          end,
        },
        {
          text = _("Info"),
          callback = function()
            UIManager:show(InfoMessage:new({
              text = _(
                "Sent as HTTP Basic auth with every request.\n"
                  .. "Stored unencrypted in the plugin settings file.\n"
                  .. "Leave the user name empty to send no credentials."
              ),
            }))
          end,
        },
        {
          text = _("Apply"),
          callback = function()
            local fields = self.basic_auth_dialog:getFields()
            self:setBasicAuth(fields[1], fields[2])
            UIManager:close(self.basic_auth_dialog)
            UIManager:show(InfoMessage:new({ text = _("Credentials saved."), timeout = 2 }))
          end,
        },
      },
    },
  })

  UIManager:show(self.basic_auth_dialog)
  self.basic_auth_dialog:onShowKeyboard()
end

function KoInsightSettings:editServerSettings()
  self.settings_dialog = MultiInputDialog:new({
    title = _("KoInsight settings"),
    fields = {
      {
        text = self.data.server_url,
        description = _("Server URL:"),
        hint = _("http://example.com:port"),
      },
    },
    buttons = {
      {
        {
          text = _("Cancel"),
          id = "close",
          callback = function()
            UIManager:close(self.settings_dialog)
          end,
        },
        {
          text = _("Info"),
          callback = function()
            UIManager:show(InfoMessage:new({
              text = _("Enter the location of your KoInsight server"),
            }))
          end,
        },
        {
          text = _("Apply"),
          callback = function()
            local myfields = self.settings_dialog:getFields()
            local server_url = myfields[1]

            if server_url == "" then
              UIManager:show(InfoMessage:new({
                text = _("Please enter a server URL."),
              }))
              return
            end

            if not server_url:match("^https?://") then
              UIManager:show(InfoMessage:new({
                text = _("The server URL must start with 'http://' or 'https://'.\n\n"),
              }))
              return
            end

            self:setServerURL(server_url)
            UIManager:close(self.settings_dialog)
            UIManager:show(InfoMessage:new({
              text = _("KoInsight settings saved."),
              timeout = 2,
            }))
          end,
        },
      },
    },
  })

  UIManager:show(self.settings_dialog)
  self.settings_dialog:onShowKeyboard()
end

function KoInsightSettings:editTimeoutDialog()
  local current = tostring(self:getSuspendConnectTimeout())
  self.timeout_dialog = MultiInputDialog:new({
    title = _("Suspend connect timeout (seconds)"),
    fields = {
      {
        text = current,
        description = _("Timeout (3..60):"),
        hint = _("10"),
        input_type = "number",
      },
    },
    buttons = {
      {
        {
          text = _("Cancel"),
          id = "close",
          callback = function()
            UIManager:close(self.timeout_dialog)
          end,
        },
        {
          text = _("Apply"),
          callback = function()
            local fields = self.timeout_dialog:getFields()
            self:setSuspendConnectTimeout(fields[1])
            UIManager:close(self.timeout_dialog)
            UIManager:show(InfoMessage:new({ text = _("Timeout saved."), timeout = 2 }))
          end,
        },
      },
    },
  })
  UIManager:show(self.timeout_dialog)
  self.timeout_dialog:onShowKeyboard()
end

return KoInsightSettings
