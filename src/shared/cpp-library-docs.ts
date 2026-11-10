/**
 * C++ 标准库常用名字的中文速查表。
 *
 * 与 `c-library-docs.ts` 同形：鼠标停在代码里的名字上时弹一条说明。
 * 这里只收 PTA 题里高频出现的容器 / 算法 / 流对象，不追求覆盖整套 STL。
 *
 * 注意：页面脚本按「光标下的完整单词」精确查表，`v.push_back(x)` 命中的是
 * `push_back`，所以成员函数也单独列出来。
 */

import type { CFunctionDoc } from './c-library-docs';

/** 名字 → 中文说明 */
export const CPP_LIBRARY_DOCS: Readonly<Record<string, CFunctionDoc>> = {
  /* ---------- 流 ---------- */
  cin: {
    signature: 'std::cin >> x',
    summary: '从标准输入读数据，自动跳过前导空白。',
    note: '读字符串遇空白就停；要读整行用 getline(cin, s)。',
  },
  cout: {
    signature: 'std::cout << x',
    summary: '往标准输出写数据。',
    note: 'PTA 上大量使用 endl 会变慢；只需要换行时写 \'\\n\'。',
  },
  endl: {
    signature: 'std::endl',
    summary: '输出一个换行并刷新缓冲区。',
    note: '刷新有开销，循环里输出几十万行时用 \'\\n\' 更快。',
  },
  getline: {
    signature: 'std::getline(std::cin, s)',
    summary: '从输入流读一整行（不含换行符）。',
    note: '前面用 cin >> 读过数字时，缓冲区里还留着换行，先 cin.ignore() 再 getline。',
  },

  /* ---------- vector ---------- */
  vector: {
    signature: 'std::vector<T> v;',
    summary: '动态数组，按下标随机访问，尾部增删很快。',
    note: 'reserve(n) 可避免反复扩容；中间插入/删除是 O(n)。',
  },
  push_back: {
    signature: 'v.push_back(x)',
    summary: '把元素追加到容器末尾。',
    note: 'vector 扩容会让已有迭代器/引用失效，循环里别一边遍历一边 push_back。',
  },
  pop_back: {
    signature: 'v.pop_back()',
    summary: '删除容器最后一个元素。',
    note: '容器为空时调用是未定义行为，先判 empty()。',
  },
  size: {
    signature: 'v.size()',
    summary: '返回元素个数，类型是无符号的 size_t。',
    note: '和 int 比较会有符号/无符号警告；倒序遍历用 int i = (int)v.size() - 1。',
  },
  empty: {
    signature: 'v.empty()',
    summary: '判断容器是否为空，O(1)。',
    note: '取 front()/back()/pop_back() 之前先判它。',
  },
  clear: {
    signature: 'v.clear()',
    summary: '删除所有元素，容量通常保留。',
  },
  front: {
    signature: 'v.front()',
    summary: '返回第一个元素（引用）。',
  },
  back: {
    signature: 'v.back()',
    summary: '返回最后一个元素（引用）。',
  },

  /* ---------- string ---------- */
  string: {
    signature: 'std::string s;',
    summary: '可变长字符串，可以用 + 拼接、用 [] 访问字符。',
    note: 's.length() 是字节数；PTA 的 ASCII 题够用，含中文时按字节算。',
  },
  substr: {
    signature: 's.substr(pos, len)',
    summary: '截取从 pos 开始、长度为 len 的子串。',
    note: 'pos 越界会抛 out_of_range；len 省略时截到末尾。',
  },
  stoi: {
    signature: 'std::stoi(s)',
    summary: '把字符串转成 int。',
    note: 's 不是合法数字会抛 invalid_argument；长整数用 stoll。',
  },
  to_string: {
    signature: 'std::to_string(x)',
    summary: '把数字转成字符串。',
    note: '浮点数默认保留 6 位小数，需要别的精度用 snprintf 或 setprecision。',
  },

  /* ---------- 算法 ---------- */
  sort: {
    signature: 'std::sort(v.begin(), v.end())',
    summary: '对区间做升序排序，平均 O(n log n)。',
    note: '需要严格弱序：比较函数对相等元素必须返回 false，否则可能越界崩溃。',
  },
  reverse: {
    signature: 'std::reverse(v.begin(), v.end())',
    summary: '原地反转区间。',
  },
  unique: {
    signature: 'std::unique(v.begin(), v.end())',
    summary: '把相邻重复元素压到末尾，返回新的逻辑结尾。',
    note: '要先 sort 才能真正去重；之后用 v.erase(it, v.end()) 缩掉尾巴。',
  },
  lower_bound: {
    signature: 'std::lower_bound(first, last, x)',
    summary: '在**已排序**区间里找第一个 >= x 的位置。',
    note: '区间没排序结果就是错的；返回迭代器，减 begin() 得到下标。',
  },
  upper_bound: {
    signature: 'std::upper_bound(first, last, x)',
    summary: '在**已排序**区间里找第一个 > x 的位置。',
  },
  binary_search: {
    signature: 'std::binary_search(first, last, x)',
    summary: '在**已排序**区间里判断 x 是否存在，O(log n)。',
    note: '只回答在不在，不返回位置；要位置用 lower_bound。',
  },
  max_element: {
    signature: 'std::max_element(first, last)',
    summary: '返回区间里最大元素的迭代器。',
    note: '区间为空时返回 last，用之前先判空。',
  },
  min_element: {
    signature: 'std::min_element(first, last)',
    summary: '返回区间里最小元素的迭代器。',
  },
  accumulate: {
    signature: 'std::accumulate(first, last, init)',
    summary: '把区间元素累加到初值 init 上。',
    note: '初值写 0 会按 int 累加，长整数要写 0LL。',
  },
  swap: {
    signature: 'std::swap(a, b)',
    summary: '交换两个同类型变量的值。',
  },
  max: {
    signature: 'std::max(a, b)',
    summary: '返回两个值里较大的那个。',
  },
  min: {
    signature: 'std::min(a, b)',
    summary: '返回两个值里较小的那个。',
  },

  /* ---------- 关联容器 ---------- */
  map: {
    signature: 'std::map<K, V> m;',
    summary: '有序键值表，按 key 自动排序，查找/插入 O(log n)。',
    note: '用 m[key] 访问不存在的 key 会插入一个默认值；只查询用 find/count。',
  },
  unordered_map: {
    signature: 'std::unordered_map<K, V> m;',
    summary: '哈希键值表，平均 O(1) 查找，元素不排序。',
    note: 'PTA 上可能被卡哈希；需要稳定性能时用 map。',
  },
  set: {
    signature: 'std::set<T> s;',
    summary: '有序集合，自动去重，操作 O(log n)。',
  },
  unordered_set: {
    signature: 'std::unordered_set<T> s;',
    summary: '哈希集合，平均 O(1) 判重，元素不排序。',
  },
  find: {
    signature: 'c.find(x)',
    summary: '查找元素，找到返回迭代器，找不到返回 c.end()。',
    note: '别把 find 的结果和 nullptr 比；统一和 c.end() 比。',
  },
  insert: {
    signature: 'c.insert(x)',
    summary: '往容器里插入元素；set/map 已存在时不会覆盖。',
  },
  erase: {
    signature: 'c.erase(it)',
    summary: '删除迭代器指向的元素，返回下一个位置。',
    note: '在循环里边遍历边 erase 时，要用 it = c.erase(it)，不要 it++。',
  },
  count: {
    signature: 'c.count(x)',
    summary: '返回等于 x 的元素个数；set/map 里只有 0 或 1。',
    note: '常用来当「是否存在」的判定，比 find 短。',
  },

  /* ---------- 适配器 ---------- */
  queue: {
    signature: 'std::queue<T> q;',
    summary: '先进先出队列。',
    note: 'push 进队、pop 出队但**不返回值**，取值要先 front()。',
  },
  priority_queue: {
    signature: 'std::priority_queue<T> pq;',
    summary: '默认大根堆，top() 是最大值，push/pop O(log n)。',
    note: '要小根堆写 priority_queue<T, vector<T>, greater<T>>。',
  },
  stack: {
    signature: 'std::stack<T> st;',
    summary: '后进先出栈。',
    note: 'pop() 不返回值，取值先用 top()。',
  },
  deque: {
    signature: 'std::deque<T> dq;',
    summary: '双端队列，头尾插入删除都是 O(1)。',
  },
  queue_push: {
    signature: 'q.push(x)',
    summary: '把元素放进队列/栈。',
  },
  top: {
    signature: 'q.top() / st.top()',
    summary: '读优先队列的最大值或栈顶元素。',
  },

  /* ---------- pair ---------- */
  pair: {
    signature: 'std::pair<A, B> p;',
    summary: '把两个值捆成一个，first / second 访问。',
    note: 'pair 默认先比 first、再比 second；二分查找常用它。',
  },
  make_pair: {
    signature: 'std::make_pair(a, b)',
    summary: '构造一个 pair，类型自动推导。',
  },
  first: {
    signature: 'p.first',
    summary: 'pair 的第一个成员。',
  },
  second: {
    signature: 'p.second',
    summary: 'pair 的第二个成员。',
  },
  begin: {
    signature: 'c.begin()',
    summary: '返回指向第一个元素的迭代器。',
  },
  end: {
    signature: 'c.end()',
    summary: '返回指向末尾后一位的迭代器（不是最后一个元素）。',
  },

  /* ---------- 常用工具 ---------- */
  gcd: {
    signature: 'std::gcd(a, b)',
    summary: '最大公约数（C++17，<numeric>）。',
  },
  __gcd: {
    signature: '__gcd(a, b)',
    summary: 'GCC 内置的最大公约数函数，竞赛代码里很常见。',
    note: '不是标准函数；标准写法是 std::gcd（需要 C++17）。',
  },
  INT_MAX: {
    signature: '#define INT_MAX 2147483647',
    summary: 'int 能表示的最大值。',
    note: '用它当「无穷大」再加一条边可能溢出，改用 0x3f3f3f3f 或 long long。',
  },
};
