import {
  getGiftApiProfile,
  getStoryApiProfile,
  parseStoryImageSettings,
  repairApiProfileRouteIds,
  type ImageApiProfile,
} from '../src/杠杠の生图机/settings';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  }
}

function profile(id: string): ImageApiProfile {
  return {
    id,
    name: id,
    serviceUrl: `https://${id}.test/v1/images/generations`,
    modelListUrl: '',
    apiKey: '',
    model: `${id}-model`,
    imageSize: '1024x1024',
    timeoutMs: 120_000,
    retryAttempts: 0,
    retryDelayMs: 1_500,
    extraBody: {},
  };
}

const profiles = [profile('profile-a'), profile('profile-b')];
const legacyActive = parseStoryImageSettings({ activeApiProfileId: 'profile-b', apiProfiles: profiles });
equal(
  [legacyActive.activeApiProfileId, legacyActive.storyApiProfileId, legacyActive.giftApiProfileId],
  ['profile-b', 'profile-b', 'profile-b'],
  '旧 active 档案必须迁移为编辑、随文和礼物三条路由',
);
equal(legacyActive.gift.multipartImageField, 'auto', '旧设置缺少 multipart 图片字段时必须迁移为 auto');

const explicitRoutes = parseStoryImageSettings({
  activeApiProfileId: 'profile-b',
  storyApiProfileId: 'profile-a',
  giftApiProfileId: 'profile-b',
  apiProfiles: profiles,
});
equal(
  [explicitRoutes.activeApiProfileId, explicitRoutes.storyApiProfileId, explicitRoutes.giftApiProfileId],
  ['profile-b', 'profile-a', 'profile-b'],
  '已有有效新路由字段不得被迁移覆盖',
);
equal(getStoryApiProfile(explicitRoutes).id, 'profile-a', '随文 selector 必须读取 story 路由');
equal(getGiftApiProfile(explicitRoutes).id, 'profile-b', '礼物 selector 必须读取 gift 路由');

const invalidRoutes = parseStoryImageSettings({
  activeApiProfileId: 'missing-active',
  storyApiProfileId: 'missing-story',
  giftApiProfileId: 'profile-b',
  apiProfiles: profiles,
});
equal(
  [invalidRoutes.activeApiProfileId, invalidRoutes.storyApiProfileId, invalidRoutes.giftApiProfileId],
  ['profile-a', 'profile-a', 'profile-b'],
  '无效路由应回退到有效 active，再回退 profiles[0]',
);

const flatLegacy = parseStoryImageSettings({
  serviceUrl: 'https://legacy.test/v1/images/generations',
  apiKey: 'legacy-key',
  model: 'legacy-model',
});
equal(
  [flatLegacy.activeApiProfileId, flatLegacy.storyApiProfileId, flatLegacy.giftApiProfileId],
  ['default-profile', 'default-profile', 'default-profile'],
  '更老扁平设置应先迁移 default profile，再统一三条路由',
);
equal(flatLegacy.apiProfiles[0].serviceUrl, 'https://legacy.test/v1/images/generations', '扁平 API 地址必须保留');

const deletion = parseStoryImageSettings({
  activeApiProfileId: 'profile-b',
  storyApiProfileId: 'profile-b',
  giftApiProfileId: 'profile-b',
  apiProfiles: [...profiles, profile('profile-c')],
});
deletion.apiProfiles.splice(1, 1);
repairApiProfileRouteIds(deletion, 'profile-c');
equal(
  [deletion.activeApiProfileId, deletion.storyApiProfileId, deletion.giftApiProfileId],
  ['profile-c', 'profile-c', 'profile-c'],
  '删除正在使用的档案后三条 ID 必须落到有效相邻档案',
);
assert(
  deletion.apiProfiles.every(item => item.id !== 'profile-b'),
  '删除测试必须实际移除目标档案',
);

console.info('<杠杠の生图机> settings route tests passed');
