/**
 * 钉钉连接流 - Node.js FaaS 脚本
 *
 * 作用：
 * 1. 接收连接流 Webhook 传入的表单数据；
 * 2. 校验分类和文字描述；
 * 3. 调用 AI 表格 OpenAPI 新增一条记录；
 * 4. 返回执行结果，前端只判断是否提交成功，不展示查询结果。
 *
 * 重要：
 * - 本脚本不会接收姓名、工号、部门、uid、unionId 等投诉人身份。
 * - operatorId 必须是固定的服务账号 unionId，不能使用投诉人的 unionId。
 * - AppKey、AppSecret 不要写进 H5。是否支持 process.env 取决于当前连接平台版本；
 *   部署时优先使用连接平台的安全配置或鉴权配置。若平台只允许脚本常量，
 *   则把密钥放在连接流后台脚本中，不要放在前端。
 */

const STATIC_CONFIG = {
  // 连接平台支持环境变量时，优先读取环境变量。
  // 不支持时，在这里填写。不要把本脚本和真实密钥提交到公开仓库。
  appKey: "",
  appSecret: "",
  baseId: "",
  sheetIdOrName: "",
  operatorId: "",

  // 表格字段名必须与 AI 表格中实际字段名完全一致。
  categoryField: "分类",
  descriptionField: "问题描述",
  statusField: "状态",
  queryCodeField: "查询码",
  clientTokenField: "客户端请求ID",
  submittedAtField: "提交时间",
  defaultStatus: "待处理",

  allowedCategories: ["行政", "人事", "业务", "其他"],
  maxDescriptionLength: 1000
};

function getEnvironment() {
  const candidates = [];

  try {
    if (typeof process !== "undefined" && process && process.env) {
      candidates.push(process.env);
    }
  } catch (error) {
    // 某些沙箱不暴露 process。
  }

  try {
    if (typeof context !== "undefined" && context && context.env) {
      candidates.push(context.env);
    }
  } catch (error) {
    // context 不是所有版本都提供。
  }

  try {
    if (globalThis && globalThis.env) {
      candidates.push(globalThis.env);
    }
  } catch (error) {
    // ignore
  }

  return Object.assign({}, ...candidates);
}

const ENV = getEnvironment();

function configValue(keys, fallback) {
  for (const key of keys) {
    if (ENV[key] !== undefined && ENV[key] !== null && String(ENV[key]).trim() !== "") {
      return String(ENV[key]).trim();
    }
  }
  return fallback;
}

const CONFIG = {
  appKey: configValue(["DINGTALK_APP_KEY", "DINGTALK_CLIENT_ID"], STATIC_CONFIG.appKey),
  appSecret: configValue(["DINGTALK_APP_SECRET", "DINGTALK_CLIENT_SECRET"], STATIC_CONFIG.appSecret),
  baseId: configValue(["DINGTALK_BASE_ID"], STATIC_CONFIG.baseId),
  sheetIdOrName: configValue(
    ["DINGTALK_SHEET_ID", "DINGTALK_SHEET_NAME"],
    STATIC_CONFIG.sheetIdOrName
  ),
  operatorId: configValue(
    ["DINGTALK_OPERATOR_UNION_ID"],
    STATIC_CONFIG.operatorId
  ),
  categoryField: configValue(["DINGTALK_CATEGORY_FIELD"], STATIC_CONFIG.categoryField),
  descriptionField: configValue(
    ["DINGTALK_DESCRIPTION_FIELD"],
    STATIC_CONFIG.descriptionField
  ),
  statusField: configValue(["DINGTALK_STATUS_FIELD"], STATIC_CONFIG.statusField),
  queryCodeField: configValue(
    ["DINGTALK_QUERY_CODE_FIELD"],
    STATIC_CONFIG.queryCodeField
  ),
  clientTokenField: configValue(
    ["DINGTALK_CLIENT_TOKEN_FIELD"],
    STATIC_CONFIG.clientTokenField
  ),
  submittedAtField: configValue(
    ["DINGTALK_SUBMITTED_AT_FIELD"],
    STATIC_CONFIG.submittedAtField
  ),
  defaultStatus: configValue(["DINGTALK_DEFAULT_STATUS"], STATIC_CONFIG.defaultStatus),
  allowedCategories: STATIC_CONFIG.allowedCategories,
  maxDescriptionLength: STATIC_CONFIG.maxDescriptionLength
};

function getRuntimeInput() {
  if (typeof input !== "undefined" && input && typeof input === "object") {
    return input;
  }
  return {};
}

function setRuntimeOutput(value) {
  if (typeof output !== "undefined" && output && typeof output === "object") {
    Object.assign(output, value);
  }
  return value;
}

function requireConfig() {
  const missing = [];
  if (!CONFIG.appKey) missing.push("DINGTALK_APP_KEY 或 DINGTALK_CLIENT_ID");
  if (!CONFIG.appSecret) missing.push("DINGTALK_APP_SECRET 或 DINGTALK_CLIENT_SECRET");
  if (!CONFIG.baseId) missing.push("DINGTALK_BASE_ID");
  if (!CONFIG.sheetIdOrName) missing.push("DINGTALK_SHEET_ID 或 DINGTALK_SHEET_NAME");
  if (!CONFIG.operatorId) missing.push("DINGTALK_OPERATOR_UNION_ID");

  if (missing.length) {
    throw new Error(`连接流配置不完整：${missing.join("、")}`);
  }
}

function toText(value, maxLength) {
  const text = value === undefined || value === null ? "" : String(value).trim();
  return text.slice(0, maxLength);
}

function validatePayload(rawInput) {
  const category = toText(rawInput.category, 20);
  const description = toText(rawInput.description, CONFIG.maxDescriptionLength + 1);
  const queryCode = toText(rawInput.queryCode, 80);
  const clientToken = toText(rawInput.clientToken, 80);

  if (rawInput.action && rawInput.action !== "submit") {
    throw new Error("当前流程只接受 action=submit");
  }
  if (!CONFIG.allowedCategories.includes(category)) {
    throw new Error("投诉分类不合法");
  }
  if (description.length < 5) {
    throw new Error("问题描述至少需要 5 个字");
  }
  if (description.length > CONFIG.maxDescriptionLength) {
    throw new Error(`问题描述不能超过 ${CONFIG.maxDescriptionLength} 个字`);
  }
  if (!/^HS-[A-Z2-9-]{10,70}$/.test(queryCode)) {
    throw new Error("查询码格式不正确");
  }
  if (clientToken && !/^[a-zA-Z0-9-]{8,80}$/.test(clientToken)) {
    throw new Error("客户端请求标识格式不正确");
  }

  return {
    category,
    description,
    queryCode,
    clientToken
  };
}

async function requestJson(url, options) {
  if (typeof fetch !== "function") {
    throw new Error("当前 FaaS 运行环境不支持 fetch，请改用平台网络请求节点");
  }

  const response = await fetch(url, options);
  const responseText = await response.text();
  let body = null;

  if (responseText) {
    try {
      body = JSON.parse(responseText);
    } catch (error) {
      body = { raw: responseText };
    }
  }

  if (!response.ok) {
    const message =
      body && (body.message || body.errmsg || body.error_description || body.code);
    throw new Error(`钉钉接口调用失败 HTTP ${response.status}${message ? `：${message}` : ""}`);
  }

  if (body && body.success === false) {
    throw new Error(body.message || body.errmsg || "钉钉接口返回失败");
  }

  return body || {};
}

async function getAccessToken() {
  const result = await requestJson("https://api.dingtalk.com/v1.0/oauth2/accessToken", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      appKey: CONFIG.appKey,
      appSecret: CONFIG.appSecret
    })
  });

  const accessToken = result.accessToken || (result.result && result.result.accessToken);
  if (!accessToken) {
    throw new Error("未获取到 accessToken");
  }
  return accessToken;
}

async function createRecord(accessToken, payload) {
  const fields = {};
  fields[CONFIG.categoryField] = payload.category;
  fields[CONFIG.descriptionField] = payload.description;
  fields[CONFIG.statusField] = CONFIG.defaultStatus;
  fields[CONFIG.queryCodeField] = payload.queryCode;
  fields[CONFIG.submittedAtField] = Date.now();

  if (payload.clientToken) {
    fields[CONFIG.clientTokenField] = payload.clientToken;
  }

  const query = new URLSearchParams({ operatorId: CONFIG.operatorId });
  if (payload.clientToken) {
    query.set("clientToken", payload.clientToken);
  }

  const endpoint =
    `https://api.dingtalk.com/v1.0/notable/bases/${encodeURIComponent(CONFIG.baseId)}` +
    `/sheets/${encodeURIComponent(CONFIG.sheetIdOrName)}/records?${query.toString()}`;

  const body = await requestJson(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-acs-dingtalk-access-token": accessToken
    },
    body: JSON.stringify({
      records: [
        {
          fields
        }
      ]
    })
  });

  const recordIds = body.value || (body.result && body.result.value) || [];
  return {
    recordId: Array.isArray(recordIds) ? recordIds[0] || "" : ""
  };
}

async function main() {
  requireConfig();

  const rawInput = getRuntimeInput();
  const payload = validatePayload(rawInput);
  const accessToken = await getAccessToken();
  const createResult = await createRecord(accessToken, payload);

  return {
    success: true,
    message: "反馈已写入 AI 表格",
    recordId: createResult.recordId,
    queryCode: payload.queryCode,
  };
}

// 连接平台 Node.js 脚本连接器通常支持直接使用 input/output。
// 使用立即执行函数兼容异步网络请求；若当前平台要求其他入口格式，
// 只需把 main() 的内容放入平台模板的导出函数即可。
return (async () => {
  try {
    return setRuntimeOutput(await main());
  } catch (error) {
    return setRuntimeOutput({
      success: false,
      errorCode: "SUBMIT_FAILED",
      message: error && error.message ? error.message : "提交处理失败"
    });
  }
})();
