/*!
 * 合成大西瓜 · 图片库与选图测试（js/library.js + js/assets.js）
 *
 * 需求：
 *   · 图片全部内嵌（不再有导入功能），用户在窗口里从图库里挑 11 张；
 *   · 图库按分组展示；有「默认图像」；颜色 = 水果 = 大小；
 *   · 用户的选择存在本地，图库换版本时不能错位。
 *
 *   node --test "C:\Users\极光\Desktop\合成大西瓜\tests\library.test.mjs"
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');

const CFG = require(path.join(ROOT, 'js/config.js'));
const LIB = require(path.join(ROOT, 'js/library.js'));
const AS = require(path.join(ROOT, 'js/assets.js'));

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
const img = (id, group, extra = {}) => Object.assign({ id, file: id + '.png', group, w: 256, h: 256, src: PNG }, extra);

function sampleLibrary() {
  return {
    version: 1,
    builtAt: '2026-01-01T00:00:00.000Z',
    groups: [
      { id: 'g1', name: '第一组', desc: '圆润的' },
      { id: 'g2', name: '第二组', desc: '写实的' }
    ],
    images: [img('i01', 'g1'), img('i02', 'g1', { w: 512, h: 512 }), img('i03', 'g2', { w: 96, h: 96 })],
    defaults: { 1: 'i01', 2: 'i02', 3: 'i03' }
  };
}

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = String(v);
    },
    removeItem: (k) => {
      delete data[k];
    },
    _data: data
  };
}

/**
 * node 里没有 Image，用最小的桩替一下（只验证预加载流程，不验证真实解码）。
 * 注意：assets.create() 里会 setTimeout 异步预加载，所以桩要一直在，不能测完就撤。
 */
globalThis.Image = class {
  constructor() {
    this.complete = false;
    this.naturalWidth = 0;
  }
  set src(v) {
    this._src = v;
    this.complete = true;
    this.naturalWidth = 64;
    if (this.onload) this.onload();
  }
  get src() {
    return this._src;
  }
};

/* ---------------- 图库清洗 ---------------- */

test('空图库 / 垃圾数据都能安全处理', () => {
  const empty = LIB.emptyLibrary();
  assert.deepEqual(empty.images, []);
  assert.deepEqual(empty.groups, []);
  assert.deepEqual(empty.defaults, {});

  [null, undefined, 0, 'x', [], {}, { images: 'nope' }, { images: [null, 1, 'a'] }].forEach((bad) => {
    const lib = LIB.normalize(bad);
    assert.deepEqual(lib.images, [], '不该有图片：' + JSON.stringify(bad));
    assert.equal(lib.fingerprint, '--------');
  });
});

test('图库清洗：非法图片丢掉、id 去重、没有 src 的不要', () => {
  const lib = LIB.normalize({
    groups: [{ id: 'g1', name: '组一' }],
    images: [
      img('i01', 'g1'),
      img('i01', 'g1'), // 重复 id
      { id: 'i02', file: 'x.png', group: 'g1' }, // 没有 src
      { id: 'i03', file: 'y.png', group: '不存在的组', src: PNG }, // 分组不存在 → 归到第一个分组
      { id: 'i04', file: 'z.png', group: 'g1', src: 'http://example.com/a.png' } // 不是内联图片
    ]
  });
  assert.deepEqual(
    lib.images.map((i) => i.id),
    ['i01', 'i03']
  );
  assert.equal(lib.images[1].group, 'g1', '分组不存在时归到第一个分组');
});

test('图库清洗：有图没分组时自动补一个「未分组」', () => {
  const lib = LIB.normalize({ images: [img('i01', undefined)] });
  assert.equal(lib.groups.length, 1);
  assert.equal(lib.images[0].group, lib.groups[0].id);
});

test('默认图像：没指定就按顺序自动铺满 11 个水果位', () => {
  const lib = LIB.normalize({ images: [img('i01', 'g1'), img('i02', 'g1')] });
  for (let t = 1; t <= 11; t++) assert.ok(lib.defaults[t], '第 ' + t + ' 级应该有默认图');
  assert.equal(lib.defaults[1], 'i01');
  assert.equal(lib.defaults[2], 'i02');
  assert.equal(lib.defaults[3], 'i01', '图不够就循环用');
});

test('默认图像：指向不存在的图片会被丢掉', () => {
  const lib = LIB.normalize({ images: [img('i01', 'g1')], defaults: { 1: 'i01', 2: '不存在', 99: 'i01' } });
  assert.deepEqual(Object.keys(lib.defaults), ['1']);
});

/* ---------------- 分组 / 查询 ---------------- */

test('分组统计与按分组取图', () => {
  const lib = LIB.normalize(sampleLibrary());
  const groups = LIB.groupsOf(lib);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].name, '第一组');
  assert.equal(groups[0].count, 2);
  assert.equal(groups[1].count, 1);
  assert.equal(LIB.imagesOf(lib, 'g2').length, 1);
  assert.equal(LIB.imagesOf(lib, '*').length, 3, '「全部」返回所有图片');
  assert.equal(LIB.imagesOf(lib, '不存在').length, 0);
});

/* ---------------- 11 个水果位 ---------------- */

test('11 个水果位：颜色 / 名字 / 直径 / 清晰度要求都来自 config', () => {
  const slots = LIB.slots();
  assert.equal(slots.length, 11);
  assert.equal(slots[0].tier, 1);
  assert.equal(slots[0].emoji, '🍒');
  assert.equal(slots[0].diameter, CFG.TIERS[0].r * 2);
  assert.equal(slots[10].diameter, 250, '西瓜直径 250px');
  assert.equal(slots[10].color, CFG.TIERS[10].color);
  assert.ok(slots[10].wantedEdge > slots[0].wantedEdge, '越大的水果对图片尺寸要求越高');
  assert.equal(LIB.slotOf(11).name, '西瓜');
  assert.equal(LIB.slotOf(99), null);
});

test('清晰度提示：图太小放到大水果上会提醒', () => {
  const big = { w: 1024, h: 1024 };
  const small = { w: 64, h: 64 };
  assert.equal(LIB.qualityHint(big, 11).ok, true);
  assert.equal(LIB.qualityHint(small, 11).ok, false, '64px 的图放到西瓜上要提示偏小');
  assert.equal(LIB.qualityHint(small, 1).ok, true, '同一张图放樱桃够用');
  assert.equal(LIB.qualityHint({ w: 0, h: 0 }, 5).text, '尺寸未知');
});

/* ---------------- 选择（pick） ---------------- */

test('选择清洗：指向不存在图片 / 越界等级的选择会被丢掉', () => {
  const lib = LIB.normalize(sampleLibrary());
  const clean = LIB.sanitizePick(lib, { 1: 'i02', 2: '不存在', 99: 'i01', 11: 'i03', abc: 'i01' });
  assert.deepEqual(clean, { 1: 'i02', 11: 'i03' });
  assert.deepEqual(LIB.sanitizePick(lib, null), {});
});

test('用哪张图：用户选的优先，其次默认图，都没有就是 null', () => {
  const lib = LIB.normalize(sampleLibrary());
  assert.equal(LIB.resolve(lib, {}, 1).id, 'i01', '没选就用默认图');
  assert.equal(LIB.resolve(lib, { 1: 'i03' }, 1).id, 'i03', '选了就用选的');
  assert.equal(LIB.resolve(lib, { 1: '不存在' }, 1).id, 'i01', '选择失效时回落到默认图');
  const empty = LIB.normalize({ images: [] });
  assert.equal(LIB.resolve(empty, {}, 1), null);
});

test('指纹：同一套图稳定，换图就变', () => {
  const a = LIB.normalize(sampleLibrary());
  const b = LIB.normalize(sampleLibrary());
  assert.equal(a.fingerprint, b.fingerprint);
  assert.match(a.fingerprint, /^[0-9a-f]{8}([0-9a-f]{8})?$/);
  const changed = LIB.normalize({
    groups: sampleLibrary().groups,
    images: [img('i01', 'g1'), img('i02', 'g1'), img('i03', 'g2', { src: PNG + 'AAAA' })],
    defaults: {}
  });
  assert.notEqual(changed.fingerprint, a.fingerprint);
});

test('统计：分组数 / 图片数 / 体积 / 默认图数量', () => {
  const st = LIB.stats(LIB.normalize(sampleLibrary()));
  assert.equal(st.groups, 2);
  assert.equal(st.images, 3);
  assert.equal(st.defaults, 3);
  assert.ok(st.bytes > 0);
  assert.equal(st.builtAt, '2026-01-01T00:00:00.000Z');
});

test('选满没选满：缺哪几位能算出来，图库为空时不算「没选满」', () => {
  const lib = LIB.normalize(sampleLibrary()); // 只有 1~3 级有默认图
  assert.deepEqual(LIB.missingSlots(lib, {}), [4, 5, 6, 7, 8, 9, 10, 11]);
  assert.equal(LIB.isComplete(lib, {}), false);

  // 只把缺的补上（图可以重复用），就算选满了
  const pick = {};
  [4, 5, 6, 7, 8, 9, 10, 11].forEach((t) => {
    pick[t] = 'i02';
  });
  assert.deepEqual(LIB.missingSlots(lib, pick), []);
  assert.equal(LIB.isComplete(lib, pick), true);

  // 图库是空的 → 不该一直弹「没选满」
  const empty = LIB.normalize({});
  assert.equal(LIB.missingSlots(empty, {}).length, 11);
  assert.equal(LIB.isComplete(empty, {}), true, '还没有内嵌图片时不该烦人');
});

/* ---------------- 运行时（assets.js） ---------------- */

test('运行时：默认用图库默认图，换图后记住选择，恢复默认能回退', async () => {
  const lib = LIB.normalize(sampleLibrary());
  const storage = fakeStorage();
  const assets = AS.create({ storage: storage, library: lib });

  assert.equal(assets.idOf(1), 'i01', '开局用默认图');
  assert.equal(assets.sourceOf(1), 'default');
  assert.equal(assets.info().filled, 3, '这份图库只给了 3 张默认图，就只填满 3 个位');
  assert.equal(assets.imageFor(4), null, '没默认图的等级回落到 emoji 外观');
  assert.equal(assets.info().libraryImages, 3);
  assert.equal(assets.info().groups, 2);

  await assets.setTier(1, 'i03');
  assert.equal(assets.idOf(1), 'i03');
  assert.equal(assets.sourceOf(1), 'pick');
  assert.equal(JSON.parse(storage.getItem(AS.PICK_KEY))['1'], 'i03', '选择要存到本地');

  // 换一个「新页面」：选择要能读回来
  const again = AS.create({ storage: storage, library: lib });
  assert.equal(again.idOf(1), 'i03', '刷新后仍然是用户选的那张');

  // 图库换版本、原来那张图没了 → 自动回落到新图库的默认图，不错位
  const otherLib = LIB.normalize({ groups: [{ id: 'g9', name: '新组' }], images: [img('n01', 'g9')] });
  const afterUpgrade = AS.create({ storage: storage, library: otherLib });
  assert.equal(afterUpgrade.idOf(1), 'n01', '图上不存在了就回到新图库的默认图');
  assert.equal(afterUpgrade.sourceOf(1), 'default');

  // 把某张图放到一个原本没有图的等级上也可以
  await assets.setTier(7, 'i02');
  assert.equal(assets.idOf(7), 'i02');

  await assets.setTier(2, null);
  assert.equal(assets.idOf(2), 'i02', '清空某一级 = 回到默认图');

  await assets.resetToDefaults();
  assert.equal(assets.idOf(1), 'i01', '恢复默认');
  assert.equal(assets.idOf(7), null, '恢复默认后第 7 级回到「没有图」');
  assert.equal(assets.info().picked, 0);
});

test('运行时：selection 变化会通知界面', async () => {
  const assets = AS.create({ storage: fakeStorage(), library: LIB.normalize(sampleLibrary()) });
  let calls = 0;
  assets.onChange(() => {
    calls += 1;
  });
  await assets.setTier(1, 'i02');
  assert.ok(calls > 0, '换图要通知界面重绘');
});

test('运行时：空图库时一切照常，只是没有图片可用（回落到 emoji 外观）', async () => {
  const assets = AS.create({ storage: fakeStorage(), library: null });
  assert.equal(assets.info().empty, true);
  assert.equal(assets.imageFor(1), null);
  assert.equal(assets.info().filled, 0);
  const res = await assets.setTier(1, '不存在');
  assert.equal(res.ok, false);
});
