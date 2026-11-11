// 演示数据仅用于界面预览，不写入真实校园墙或交易数据库。
const materials = [{
    id: 'demo-calculus',
    title: '高等数学 · 微积分知识梳理',
    course: '高等数学',
    type: '课程笔记',
    summary: '从极限到积分，按章节整理概念与推导。',
    price: '8.00',
    author: '林同学',
    pages: 32,
    badge: '原创笔记',
    color: 'blue'
  },
  {
    id: 'demo-accounting',
    title: '会计循环 · 分录与报表速查',
    course: '会计学',
    type: '复习总结',
    summary: '用完整例子串起分录、试算平衡与报表。',
    price: '6.00',
    author: '周同学',
    pages: 24,
    badge: '原创总结',
    color: 'cyan'
  },
  {
    id: 'demo-english',
    title: '大学英语 · 学术写作结构笔记',
    course: '大学英语',
    type: '课程笔记',
    summary: '段落逻辑、引文与修改清单，附自编例句。',
    price: '5.00',
    author: '陈同学',
    pages: 20,
    badge: '原创笔记',
    color: 'mint'
  },
  {
    id: 'demo-linear',
    title: '线性代数 · 概念与例题索引',
    course: '线性代数',
    type: '复习总结',
    summary: '矩阵、向量空间与特征值的知识连接。',
    price: '7.00',
    author: '苏同学',
    pages: 28,
    badge: '原创总结',
    color: 'blue'
  },
];
const activities = [{
    id: 'demo-business',
    title: '创新创业大赛 · 一起把想法落地',
    type: '比赛',
    date: '演示日期',
    roles: ['商业计划书', '数据分析', '前端开发'],
    description: '围绕校园服务做一个小项目，寻找愿意一起研究的队友。',
    members: 3,
    capacity: 5
  },
  {
    id: 'demo-reading',
    title: '周末阅读分享 · 带一本喜欢的书',
    type: '活动',
    date: '演示日期',
    roles: ['分享交流', '活动策划'],
    description: '从一本书开始，认识有相似兴趣的同学。',
    members: 6,
    capacity: 10
  },
  {
    id: 'demo-research',
    title: '校园公共空间观察课题',
    type: '课题',
    date: '演示日期',
    roles: ['调研访谈', '数据分析'],
    description: '一起观察校园里的学习与交流空间。',
    members: 2,
    capacity: 4
  },
];
module.exports = {
  materials,
  activities
};
