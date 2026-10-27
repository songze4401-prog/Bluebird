/**
 * 云岫 Bluebird — 记忆评测基线固定数据（阶段 0：只读审计配套）
 *
 * 本文件只提供数据，不做任何断言、不修改任何生产代码：
 *   SEEDS       —— 22 条种子记忆，字段形状与 server/memory.js 落盘格式逐字一致
 *                  （content / type / keywords / confidence / contributions[] /
 *                   createdAt / updatedAt，没有 id、validFrom、validTo、status、version）。
 *   QUESTIONS   —— 26 道固定题，覆盖用户偏好 / 项目进展 / 事实更正 / 跨会话召回 /
 *                  跨会话泄漏 / 删除后残留 / 无答案问题。
 *   PHASE2_WRITES —— 事实更正题需要的候选记忆（喂给假 client，让真实
 *                  processMemory 的判定与去重逻辑自己跑）。
 *
 * 条数刻意 > SMALL_MEMORY_LIMIT(15)：否则 buildMemoryContext 走
 * 「全量注入、跳过相关性过滤」分支（server/memory.js:639-641），
 * 排序与过滤行为根本不会被测到。
 *
 * 时间基准：所有 createdAt 由 at(分钟偏移) 生成，撤回时间窗
 * （server/memory.js:961-966，[消息时间-5s, 消息时间+2h]）据此构造。
 */

const BASE_TIME = Date.parse('2026-10-20T09:00:00.000Z');

function at(minutesOffset) {
  return new Date(BASE_TIME + minutesOffset * 60 * 1000).toISOString();
}

// 会话名：s-main 是题目默认提问会话；其余会话的记忆对本会话应被隔离。
const SESSIONS = Object.freeze({
  main: 's-main',
  work: 's-work',
  pet: 's-private',
  fresh: 's-fresh-new-session',
});

function contrib(sessionId, sourceQuote, minutesOffset) {
  return {
    sessionId,
    sourceQuote,
    createdAt: at(minutesOffset),
  };
}

/**
 * 种子记忆库。
 * `id` 只存在于评测侧（生产数据格式没有 id），用于把检索回来的 content
 * 映射回题目 expect/forbid 列表；seed() 会把 id 剥掉再落盘，
 * 保证 loadMemories() 读到的就是生产形状。
 */
const SEEDS = [
  {
    id: 'M01',
    content: '用户喝咖啡只喝拿铁，不加糖',
    type: 'preference',
    keywords: ['咖啡', '拿铁'],
    confidence: 0.95,
    contributions: [contrib(SESSIONS.main, '我喝咖啡只喝拿铁', -400)],
  },
  {
    id: 'M02',
    content: '用户不吃香菜，点菜要备注去掉香菜',
    type: 'preference',
    keywords: ['香菜', '忌口'],
    confidence: 0.95,
    contributions: [contrib(SESSIONS.main, '我不吃香菜', -390)],
  },
  {
    id: 'M03',
    content: '用户叫宋泽',
    type: 'identity',
    keywords: ['名字', '宋泽'],
    confidence: 0.98,
    contributions: [contrib(SESSIONS.main, '我叫宋泽', -380)],
  },
  {
    // 仅 s-work 名下的私有事实：s-main 的 scoped 检索不应拿到它。
    id: 'M04',
    content: '用户的车牌号是沪A12345',
    type: 'fact',
    keywords: ['车牌', '车牌号'],
    confidence: 0.95,
    contributions: [contrib(SESSIONS.work, '我的车牌是沪A12345', -370)],
  },
  {
    id: 'M05',
    content: '用户现在住在杭州西湖区',
    type: 'fact',
    keywords: ['城市', '杭州', '住'],
    confidence: 0.9,
    contributions: [contrib(SESSIONS.work, '我住在杭州西湖区', -360)],
  },
  {
    id: 'M06',
    content: '用户在开发云岫 Bluebird 这款 AI 聊天应用',
    type: 'goal',
    keywords: ['Bluebird', '项目', '云岫'],
    confidence: 0.9,
    contributions: [contrib(SESSIONS.main, '我在做Bluebird这个项目', -350)],
  },
  {
    id: 'M07',
    content: '用户计划本周五之前完成记忆系统审计',
    type: 'goal',
    keywords: ['审计', '周五', '计划'],
    confidence: 0.9,
    contributions: [contrib(SESSIONS.main, '我周五前要做完记忆审计', -340)],
  },
  {
    id: 'M08',
    content: '用户偏好深色主题的界面',
    type: 'preference',
    keywords: ['主题', '深色'],
    confidence: 0.9,
    contributions: [contrib(SESSIONS.main, '我喜欢深色主题', -330)],
  },
  {
    id: 'M09',
    content: '用户养了一只两岁的猫，名字叫小雪',
    type: 'fact',
    keywords: ['猫', '小雪'],
    confidence: 0.95,
    contributions: [contrib(SESSIONS.pet, '我的猫叫小雪', -320)],
  },
  {
    id: 'M10',
    content: '用户对花粉过敏',
    type: 'fact',
    keywords: ['过敏', '花粉'],
    confidence: 0.95,
    contributions: [contrib(SESSIONS.main, '我对花粉过敏', -310)],
  },
  {
    id: 'M11',
    content: '用户希望始终用中文回复',
    type: 'preference',
    keywords: ['中文', '语言'],
    confidence: 0.9,
    contributions: [contrib(SESSIONS.main, '以后都用中文回我', -300)],
  },
  {
    // 无归属（sessionId:null）旧数据：scoped 检索按设计会在本会话无贡献时
    // 回退到这类记忆（server/memory.js:857-858,870-872），
    // 任何新会话都读得到 —— 这是「legacy 暴露面」，单列指标。
    id: 'M12',
    content: '用户的小名是小蓝',
    type: 'fact',
    keywords: ['小名'],
    confidence: 0.9,
    contributions: [contrib(null, '叫我小蓝就好', -290)],
  },
  {
    id: 'M13',
    content: '用户上周去青岛出差了三天',
    type: 'fact',
    keywords: ['青岛', '出差'],
    confidence: 0.9,
    contributions: [contrib(SESSIONS.main, '我上周去青岛出差', -280)],
  },
  {
    id: 'M14',
    content: '用户想养成每周跑三次步的习惯',
    type: 'goal',
    keywords: ['跑步', '锻炼'],
    confidence: 0.9,
    contributions: [contrib(SESSIONS.main, '我想每周跑步三次', -270)],
  },
  {
    id: 'M15',
    content: '用户爱吃辣，偏好湖南口味',
    type: 'preference',
    keywords: ['辣', '口味'],
    confidence: 0.9,
    contributions: [contrib(SESSIONS.main, '我爱吃辣', -260)],
  },
  {
    id: 'M16',
    content: '用户用 Windows 11 电脑做开发',
    type: 'fact',
    keywords: ['Windows', '系统', '电脑'],
    confidence: 0.9,
    contributions: [contrib(SESSIONS.main, '我用Windows电脑开发', -250)],
  },
  {
    // 与 M01 共享关键词「咖啡」：Q01 的 Precision 天然受它拖累（真实干扰项）。
    id: 'M17',
    content: '用户不爱喝茶，只喝咖啡',
    type: 'preference',
    keywords: ['茶', '咖啡'],
    confidence: 0.9,
    contributions: [contrib(SESSIONS.main, '我不爱喝茶', -240)],
  },
  {
    id: 'M18',
    content: '用户是软件工程师',
    type: 'identity',
    keywords: ['职业', '工程师'],
    confidence: 0.95,
    contributions: [contrib(SESSIONS.main, '我是软件工程师', -230)],
  },
  {
    id: 'M19',
    content: '用户的生日是3月14日',
    type: 'fact',
    keywords: ['生日'],
    confidence: 0.95,
    contributions: [contrib(SESSIONS.main, '我生日是3月14日', -220)],
  },
  {
    id: 'M20',
    content: '用户正在准备研究生入学考试',
    type: 'goal',
    keywords: ['考研', '考试', '备考'],
    confidence: 0.9,
    contributions: [contrib(SESSIONS.pet, '我在准备考研', -210)],
  },
  {
    // 多会话共同支持的同一条事实：撤回其中一个会话的贡献后，整条记忆必须留下。
    id: 'M21',
    content: '用户常用的编辑器是 VS Code',
    type: 'fact',
    keywords: ['编辑器'],
    confidence: 0.9,
    contributions: [
      contrib(SESSIONS.main, '我常用编辑器是VS Code', -200),
      contrib(SESSIONS.work, '我们组都用VS Code', -150),
    ],
  },
  {
    // 既有本会话贡献、又有无归属旧贡献：scoped 检索只应看到 primary 那条。
    id: 'M22',
    content: '用户的项目代码放在 GitHub 私有仓库',
    type: 'fact',
    keywords: ['仓库', 'GitHub', '项目'],
    confidence: 0.9,
    contributions: [
      contrib(SESSIONS.work, '代码在GitHub私有仓库', -140),
      contrib(null, '仓库是GitHub私有的', -130),
    ],
  },
];

/** 落盘形状：剥掉评测侧 id，只保留生产字段。 */
function seed() {
  return SEEDS.map(({ id, ...productionShape }) => ({
    ...productionShape,
    createdAt: productionShape.contributions[0].createdAt,
    updatedAt: productionShape.contributions[
      productionShape.contributions.length - 1
    ].createdAt,
  }));
}

/** content → 评测 id 的注册表（含事实更正阶段新写入的候选）。 */
function registry() {
  const map = new Map();

  for (const item of SEEDS) map.set(item.content, item.id);

  return map;
}

// ---- 事实更正题：候选记忆（由假 client 返回，交给真实 processMemory 判定） ----
// 是否命中 ≥0.8 去重覆盖（server/memory.js:509-533）不预设结论：
// 评测只如实记录写入后的库内容与检索结果（旧条目还在不在、谁排在前面）。
const PHASE2_WRITES = [
  {
    key: 'birthdayCorrection',
    newId: 'N19',
    userText: '记住：我的生日其实是6月20日，之前说错了',
    reply: {
      content: '用户的生日是6月20日',
      type: 'fact',
      keywords: ['生日'],
      confidence: 0.95,
      sourceQuote: '我的生日其实是6月20日',
    },
    replaces: 'M19',
    probeQuery: '我的生日是哪天',
  },
  {
    key: 'catRename',
    newId: 'N09',
    userText: '记住：我把猫的名字从小雪改成糯糯了',
    reply: {
      content: '用户的猫名字叫糯糯，两岁',
      type: 'fact',
      keywords: ['猫', '糯糯'],
      confidence: 0.95,
      sourceQuote: '我把猫的名字从小雪改成糯糯了',
    },
    replaces: 'M09',
    probeQuery: '我的猫叫什么名字',
  },
  {
    key: 'lowConfidenceRejected',
    newId: null,
    userText: '记住：我最近在学弹吉他',
    reply: {
      content: '用户在学弹吉他',
      type: 'fact',
      keywords: ['吉他'],
      confidence: 0.6,
      sourceQuote: '我最近在学弹吉他',
    },
    replaces: null,
    probeQuery: '我在学什么乐器',
  },
];

// ---- 固定题库 ----
/**
 * 拒写原因鉴别探针（phase 2 末尾，独立 reseed 后跑）。
 * 每个探针只改一道闸门，其余条件全部相同，跑完能直接读出这次拒写属于哪一类，
 * 这样「模型没提取 / 被锚点拒 / 被置信度拒」在基线里就是三个可核对的短码，
 * 而不是同一行 Memory skipped。
 *
 * expectWritten + expectReason 是硬判据：探针写进了不该写的、或该写的没写进，
 * 都会进 metrics.gateProbeMismatches，CI 闸门据此失败。
 * consumePendingIntent=true 表示跑这条之前要先清空「上一条被拒候选留下的待记忆意图」，
 * 否则 server 会把本条也当记忆指令处理，not_triggered 就测不准了。
 */
const GATE_PROBES = [
  {
    key: 'anchorSimilarityProbe',
    userText: '记住：我把猫的名字从小雪改成糯糯了',
    reply: {
      content: '我把猫的名字从小雪改成糯糯了',
      type: 'fact',
      keywords: ['猫', '名字'],
      confidence: 0.95,
      sourceQuote: '我把猫的名字从小雪改成糯糯了',
    },
    expectWritten: true,
    expectReason: null,
  },
  {
    key: 'confidenceGateProbe',
    userText: '记住：我最近在学弹吉他',
    reply: {
      content: '我最近在学弹吉他',
      type: 'goal',
      keywords: ['吉他'],
      confidence: 0.6,
      sourceQuote: '我最近在学弹吉他',
    },
    expectWritten: false,
    expectReason: 'low_confidence',
  },
  {
    key: 'anchorGateProbe',
    userText: '记住：我家猫今天做绝育手术了',
    reply: {
      // 原话只说「猫今天做绝育手术」，正文却写成诊疗决策 + 财务安排：
      // 关键词一个都不在原话里，锚点相似度也远低于 0.15 —— 模型自己加的戏。
      content: '用户已完成宠物医疗决策并安排了后续康复与财务支出计划',
      type: 'fact',
      keywords: ['康复', '财务'],
      confidence: 0.95,
      sourceQuote: '我家猫今天做绝育手术了',
    },
    expectWritten: false,
    expectReason: 'ungrounded_content',
  },
  {
    key: 'modelEmptyProbe',
    userText: '记住：我的工位靠窗',
    // 字符串正文 = 模型根本没按 JSON 返回，parseModelJson 直接失败。
    reply: '这个我不太确定该怎么记。',
    expectWritten: false,
    expectReason: 'model_empty',
  },
  {
    key: 'notTriggeredProbe',
    userText: '今天天气不错',
    reply: {
      content: '用户觉得今天天气不错',
      type: 'fact',
      keywords: ['天气'],
      confidence: 0.95,
      sourceQuote: '今天天气不错',
    },
    expectWritten: false,
    expectReason: 'not_triggered',
    consumePendingIntent: true,
  },
];
// expect  = 本会话 scoped 检索应当命中的 id（语义正确答案）
// forbid  = 本会话绝不该看到、且全局注入路径看到即算泄漏的 id
// cross   = 事实存在但只属于其他会话的 id：scoped 路径拿不到（召回损失），
//           注入路径拿得到（跨会话可见）—— 两条路径结论不一致本身即指标
// phase   = 1 排序检索 / 2 事实更正 / 3 删除残留
const QUESTIONS = [
  // A. 用户偏好
  {
    id: 'Q01',
    cat: '偏好',
    phase: 1,
    session: SESSIONS.main,
    query: '我喜欢喝什么咖啡',
    expect: ['M01'],
    forbid: ['M04', 'M09', 'M20'],
  },
  {
    id: 'Q02',
    cat: '偏好',
    phase: 1,
    session: SESSIONS.main,
    query: '我有什么忌口',
    expect: ['M02'],
    forbid: ['M04', 'M09'],
  },
  {
    id: 'Q03',
    cat: '偏好',
    phase: 1,
    session: SESSIONS.main,
    query: '界面用什么主题比较好',
    expect: ['M08'],
    forbid: [],
  },
  {
    id: 'Q04',
    cat: '偏好',
    phase: 1,
    session: SESSIONS.main,
    query: '我的口味偏好是什么',
    expect: ['M15'],
    forbid: [],
  },
  {
    id: 'Q05',
    cat: '偏好',
    phase: 1,
    session: SESSIONS.main,
    query: '我平时用什么编辑器',
    expect: ['M21'],
    forbid: [],
  },
  // B. 项目进展
  {
    id: 'Q06',
    cat: '进展',
    phase: 1,
    session: SESSIONS.main,
    query: '我在做什么项目',
    expect: ['M06'],
    forbid: [],
    note: 'M22 也含关键词「项目」，但只属 s-work/legacy',
  },
  {
    id: 'Q07',
    cat: '进展',
    phase: 1,
    session: SESSIONS.main,
    query: '这周有什么要赶的计划',
    expect: ['M07'],
    forbid: [],
  },
  {
    id: 'Q08',
    cat: '进展',
    phase: 1,
    session: SESSIONS.main,
    query: '我想养成什么运动习惯',
    expect: ['M14'],
    forbid: [],
  },
  {
    id: 'Q09',
    cat: '进展',
    phase: 1,
    session: SESSIONS.main,
    query: '我用什么电脑系统开发',
    expect: ['M16'],
    forbid: [],
  },
  // C. 跨会话召回（身份类：identity 被无条件置顶 ≤2 条）
  {
    id: 'Q10',
    cat: '跨会话召回',
    phase: 1,
    session: SESSIONS.main,
    query: '我叫什么名字',
    expect: ['M03', 'M18'],
    forbid: [],
    note: '两条 identity 均被置顶注入，字面不相关也在',
  },
  {
    id: 'Q11',
    cat: '跨会话召回',
    phase: 1,
    session: SESSIONS.main,
    query: '我住在哪个城市',
    expect: [],
    forbid: ['M05'],
    cross: 'M05',
  },
  {
    id: 'Q12',
    cat: '跨会话召回',
    phase: 1,
    session: SESSIONS.main,
    query: '我的车牌号是多少',
    expect: [],
    forbid: ['M04'],
    cross: 'M04',
  },
  {
    id: 'Q13',
    cat: '跨会话召回',
    phase: 1,
    session: SESSIONS.main,
    query: '我的猫叫什么名字',
    expect: [],
    forbid: ['M09'],
    cross: 'M09',
  },
  {
    id: 'Q14',
    cat: '跨会话召回',
    phase: 1,
    session: SESSIONS.main,
    query: '我在备考什么',
    expect: [],
    forbid: ['M20'],
    cross: 'M20',
  },
  // D. 跨会话泄漏（全新会话 / legacy 回退）
  {
    id: 'Q15',
    cat: '泄漏',
    phase: 1,
    session: SESSIONS.fresh,
    query: '我叫什么名字',
    expect: [],
    forbid: ['M03', 'M18', 'M04', 'M09', 'M20', 'M01'],
    note: '全新会话应一无所知（identity 也在别的会话名下）',
  },
  {
    id: 'Q16',
    cat: '泄漏',
    phase: 1,
    session: SESSIONS.fresh,
    query: '我的小名是什么',
    expect: ['M12'],
    forbid: ['M03', 'M09'],
    note: 'legacy 无归属记忆按设计对新会话可见（单列 legacy 暴露指标）',
  },
  // E. 无答案问题
  {
    id: 'Q17',
    cat: '无答案',
    phase: 1,
    session: SESSIONS.main,
    query: '我上次点的披萨是什么口味',
    expect: [],
    forbid: ['M04', 'M09'],
    note: '库里没有披萨口味；「口味」关键词会勾出 M15',
  },
  {
    id: 'Q18',
    cat: '无答案',
    phase: 1,
    session: SESSIONS.main,
    query: '今天天气怎么样',
    expect: [],
    forbid: ['M04', 'M09'],
  },
  {
    id: 'Q19',
    cat: '无答案',
    phase: 1,
    session: SESSIONS.main,
    query: '我的护照号码是多少',
    expect: [],
    forbid: ['M04', 'M09'],
    note: '护照不在 SENSITIVE_PATTERN 内，纯无答案题',
  },
  // F. 事实更正（phase 2，先写入再检索）
  {
    id: 'Q20',
    cat: '事实更正',
    phase: 2,
    session: SESSIONS.main,
    writeKey: 'birthdayCorrection',
    query: '我的生日是哪天',
    expect: ['N19'],
    forbid: [],
    residueOf: 'M19',
  },
  {
    id: 'Q21',
    cat: '事实更正',
    phase: 2,
    session: SESSIONS.main,
    writeKey: 'catRename',
    query: '我的猫叫什么名字',
    expect: ['N09'],
    forbid: ['M09'],
    // M09 属于 s-private；s-main 的更正不得把它当作可跨会话修正的旧事实。
    // 因此它不构成本会话的“更正残留”，只能在 forbid 里证明 s-main 读不到它。
    residueOf: null,
    note: '新事实写在 s-main 名下；旧 M09 属 s-private，跨会话不可修正也不可读取',
  },
  {
    id: 'Q22',
    cat: '事实更正',
    phase: 2,
    session: SESSIONS.main,
    writeKey: 'lowConfidenceRejected',
    query: '我在学什么乐器',
    expect: [],
    forbid: [],
    expectWritten: false,
  },
  // G. 删除后残留（phase 3）
  {
    id: 'Q23',
    cat: '删除残留',
    phase: 3,
    op: 'deleteMemory',
    session: SESSIONS.main,
    target: 'M01',
    query: '我喜欢喝什么咖啡',
    expect: ['M17'],
    forbid: [],
    residueOf: 'M01',
  },
  {
    id: 'Q24',
    cat: '删除残留',
    phase: 3,
    op: 'recallPartial',
    session: SESSIONS.main,
    target: 'M21',
    dropContribution: SESSIONS.main,
    messageText: '我常用编辑器是VS Code',
    messageAtMinutes: -201,
    query: '我平时用什么编辑器',
    expect: ['M21'],
    forbid: [],
    mustSurvive: true,
    residueOf: null,
    note: '只摘掉 s-main 的贡献，s-work 还在 → 整条记忆必须保留（不是残留）',
  },
  {
    id: 'Q25',
    cat: '删除残留',
    phase: 3,
    op: 'recallLast',
    session: SESSIONS.work,
    target: 'M21',
    dropContribution: SESSIONS.work,
    messageText: '我们组都用VS Code',
    messageAtMinutes: -151,
    query: '我平时用什么编辑器',
    expect: [],
    forbid: [],
    residueOf: 'M21',
    note: '贡献被摘空 → 整条应删除；s-main 之后再检索应拿不到',
  },
  {
    id: 'Q26',
    cat: '删除残留',
    phase: 3,
    op: 'clearMemories',
    session: SESSIONS.main,
    target: null,
    queries: ['我喜欢喝什么咖啡', '我叫什么名字', '我的车牌号是多少'],
    residueOf: 'ALL',
  },
];

/**
 * 撤回误删防护探针（phase 3 最先跑）。
 * 消息时间刻意取「贡献时间 − 1 分钟」，落在时间窗
 * [消息时间−5s, 消息时间+2h]（server/memory.js:961-966）之内，
 * 这样 S1 不掉 M09 的原因只能是「会话归属不匹配」而不是时间窗拦住了；
 * S2 用同一条文本、同一时间、换成 s-private 会话，应当真的摘掉它，
 * 两条一起构成对照。
 */
const SAFETY_PROBES = [
  {
    id: 'S1',
    session: SESSIONS.main,
    messageText: '我的猫叫小雪',
    messageAtMinutes: -321,
    expectDropped: 0,
    mustSurvive: ['M09'],
  },
  {
    id: 'S2',
    session: SESSIONS.pet,
    messageText: '我的猫叫小雪',
    messageAtMinutes: -321,
    expectDropped: 1,
    mustDrop: ['M09'],
  },
];

module.exports = {
  BASE_TIME,
  SEEDS,
  SESSIONS,
  QUESTIONS,
  PHASE2_WRITES,
  GATE_PROBES,
  SAFETY_PROBES,
  at,
  contrib,
  seed,
  registry,
};
