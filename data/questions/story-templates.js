export const STORY_TEMPLATES = Object.freeze({
  addition: [
    ({ left, right }) => `小英雄收集了 ${left} 颗星星，又得到了 ${right} 颗，一共有几颗？`,
    ({ left, right }) => `桃源村原来有 ${left} 个苹果，又送来了 ${right} 个，现在有几个？`,
  ],
  subtraction: [
    ({ left, right }) => `宝箱里有 ${left} 枚金币，用掉 ${right} 枚，还剩几枚？`,
    ({ left, right }) => `小英雄有 ${left} 支魔法笔，送给朋友 ${right} 支，还剩几支？`,
  ],
  successor: [
    ({ left }) => `数字 ${left} 后面的一个数字是几？`,
    ({ left }) => `数到 ${left} 后，下一个数字是几？`,
  ],
});
