---
mode: 'agent'
tools: ['codebase']
description: 'Deep code review with error detection, correction, and best practices for Python, JavaScript, and Java'
---

# Code Review — Error Detection & Correction Guide

## Step 0 — Read Fully Before Reviewing
- Read the entire file/selection — not just the flagged area
- Understand the intent: what is this code trying to do?
- Trace all code paths including error paths
- Check how this code connects to other parts of the system
- Reference existing code conventions in the project

**Output format:**
```
LINE XX: [SEVERITY] — ISSUE
  Found:   {exact problematic code}
  Problem: {why it's wrong}
  Fixed:   {corrected code}
```
Severity: BUG | PERF | SECURITY | STYLE | DESIGN

---

## Category 1 — Logic & Bug Detection

### Python
```python
# BUG — Mutable default argument (shared across all calls)
def add_item(item, items=[]):       # BAD — same list reused every call!
    items.append(item)
    return items

def add_item(item, items=None):     # GOOD
    if items is None:
        items = []
    items.append(item)
    return items

# BUG — Walrus operator / assignment in condition
if result = db.execute(query):      # BAD — assignment not comparison

# BUG — Comparing with is instead of ==
if user_role is "admin":            # BAD — identity not equality
if user_role == "admin":            # GOOD

# BUG — Silent exception swallowing
try:
    result = dangerous_operation()
except:                             # BAD — catches EVERYTHING including KeyboardInterrupt
    pass

except Exception as e:              # GOOD — catch specific, log it
    logger.error(f"Operation failed: {e}")
    raise

# BUG — Off-by-one in pagination
items = db.query(Item).limit(page * page_size)     # BAD — wrong offset logic
items = db.query(Item).offset((page-1)*page_size).limit(page_size)  # GOOD

# BUG — Modifying list while iterating
for item in items:
    if item.expired:
        items.remove(item)          # BAD — skips items!

items = [i for i in items if not i.expired]        # GOOD

# PERF — N+1 query
for user in users:
    user.orders = db.query(Order).filter(Order.user_id == user.id).all()  # N+1!

# GOOD — load with joinedload/selectinload
users = db.query(User).options(joinedload(User.orders)).all()
```

### JavaScript
```javascript
// BUG — Missing await on async call
async function processItem(id) {
  const item = getItemFromDB(id);   // BAD — forgot await, item is a Promise
  if (!item) return null;           // always true — Promise is truthy!
  
  const item = await getItemFromDB(id); // GOOD
}

// BUG — Promise.all vs sequential (performance)
// BAD — sequential (unnecessary waiting)
const users = await fetchUsers();
const orders = await fetchOrders();

// GOOD — parallel (if independent)
const [users, orders] = await Promise.all([fetchUsers(), fetchOrders()]);

// BUG — Unhandled promise rejection
fetchData().then(process);          // BAD — rejection unhandled

fetchData().then(process).catch(err => {
  logger.error('fetchData failed:', err);
  throw err;                        // GOOD — log and re-throw or handle
});

// BUG — typeof check for null
typeof null === 'object'            // true! null is not an object
if (typeof data === 'object') {}   // BAD — matches null

if (data !== null && typeof data === 'object') {} // GOOD

// BUG — parseInt without radix
parseInt("08")                      // BAD — might be octal in old engines
parseInt("08", 10)                  // GOOD — explicit base 10

// PERF — Inefficient array operations
const found = largeArray.filter(x => x.id === id)[0]; // scans entire array
const found = largeArray.find(x => x.id === id);       // stops at first match

// BUG — Race condition in async state
let isLoading = false;
async function load() {
  if (isLoading) return;
  isLoading = true;                 // BAD — not atomic, concurrent calls can both pass
  // ...
}
```

### Java
```java
// BUG — NullPointerException risk
String name = user.getProfile().getName();  // NPE if profile is null
String name = Optional.ofNullable(user.getProfile())
    .map(Profile::getName)
    .orElse("Unknown");                      // GOOD

// BUG — String comparison
if (status == "active") {}          // BAD — reference equality, not value
if ("active".equals(status)) {}     // GOOD — null-safe, value equality

// BUG — Integer overflow
int result = largeInt * largeInt;   // BAD — may overflow silently
long result = (long) largeInt * largeInt; // GOOD

// BUG — ConcurrentModificationException
for (Item item : items) {
    if (item.isExpired()) items.remove(item); // BAD — CME!
}
items.removeIf(Item::isExpired);    // GOOD

// PERF — Repeated string concatenation in loop
String result = "";
for (String s : list) result += s;  // BAD — O(n²) — creates new String each iteration
StringBuilder sb = new StringBuilder();
for (String s : list) sb.append(s); // GOOD — O(n)
String result = sb.toString();

// BUG — Resource leak
Connection conn = dataSource.getConnection();
// ... use conn ...
// BAD — conn not closed if exception thrown

try (Connection conn = dataSource.getConnection()) { // GOOD — auto-closed
    // ... use conn ...
}
```

---

## Category 2 — Performance Issues

### Python
```python
# PERF — Repeated .lower() call in loop
for item in items:
    if search_term.lower() in item.name.lower():  # .lower() called every iteration
        
search_lower = search_term.lower()  # compute once
for item in items:
    if search_lower in item.name.lower():

# PERF — Reading entire file into memory
content = open('large_file.txt').read()  # BAD for large files

with open('large_file.txt') as f:
    for line in f:                   # GOOD — streams line by line
        process(line)

# PERF — Unused import / dead code
import os, sys, json, re, datetime   # BAD — import only what you use

# PERF — Blocking IO in async function
async def get_data():
    time.sleep(5)                    # BAD — blocks entire event loop!
    await asyncio.sleep(5)           # GOOD — yields to other coroutines
```

### JavaScript
```javascript
// PERF — Blocking the event loop
app.get('/data', (req, res) => {
  const result = JSON.parse(hugeJsonString); // BAD — blocks if huge
  // For large parsing, use streaming or worker threads
});

// PERF — Unnecessary re-renders / recomputation
// Check if expensive operations are memoized or cached

// PERF — Logging in hot paths
for (const item of millionItems) {
  console.log(`Processing ${item.id}`); // BAD — logging in tight loop
}
```

---

## Category 3 — Error Handling Quality

### Python
```python
# BAD — Generic error message hides root cause
except Exception:
    return {"error": "Something went wrong"}  # impossible to debug

# GOOD — Log full detail, return safe message
except IntegrityError as e:
    logger.error(f"DB constraint violation: {e}", exc_info=True)
    raise HTTPException(status_code=409, detail="Resource already exists")

except Exception as e:
    logger.error(f"Unexpected error in create_item: {e}", exc_info=True)
    raise HTTPException(status_code=500, detail="Internal server error")

# BAD — Exception in finally block hides original exception
try:
    process()
except Exception as e:
    raise
finally:
    cleanup()  # BAD if cleanup() also raises — original exception lost

# GOOD
try:
    process()
except Exception as e:
    raise
finally:
    try:
        cleanup()
    except Exception as cleanup_err:
        logger.warning(f"Cleanup failed: {cleanup_err}")  # log but don't re-raise
```

### JavaScript
```javascript
// BAD — Error object lost
try {
  await processItem();
} catch (err) {
  throw new Error('Processing failed');  // BAD — original err lost, no stack trace
}

// GOOD — preserve original error
try {
  await processItem();
} catch (err) {
  logger.error('Processing failed:', err);
  throw Object.assign(new Error('Processing failed'), { cause: err, status: 500 });
}

// BAD — Async error not caught
router.get('/items', async (req, res) => {
  const items = await service.list();  // BAD — if throws, Express doesn't catch async errors
  res.json(items);
});

// GOOD — wrap or use asyncHandler
router.get('/items', asyncHandler(async (req, res) => {
  const items = await service.list();
  res.json(items);
}));
// asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req,res,next)).catch(next)
```

---

## Category 4 — Code Readability

```python
# STYLE — Magic numbers
if user.score > 75:                  # BAD — what does 75 mean?
    grant_premium_access()

PREMIUM_SCORE_THRESHOLD = 75         # GOOD — named constant
if user.score > PREMIUM_SCORE_THRESHOLD:
    grant_premium_access()

# STYLE — Long function doing too many things (> 40 lines is a warning)
async def handle_order(data):        # BAD — doing 10 different things
    # validate
    # check inventory  
    # calculate price
    # apply discounts
    # create order
    # notify user
    # update analytics
    # ...

# GOOD — extract into focused functions
async def handle_order(data):
    validated = validate_order(data)
    price = await calculate_final_price(validated)
    order = await create_order(validated, price)
    await post_order_effects(order)  # notifications, analytics as side effect
    return order

# STYLE — Nested ternary (unreadable)
status = "premium" if score > 90 else "standard" if score > 50 else "basic"

# GOOD
if score > 90: status = "premium"
elif score > 50: status = "standard"
else: status = "basic"
```

```javascript
// STYLE — Callback hell
getUser(id, (user) => {
  getOrders(user.id, (orders) => {
    processOrders(orders, (result) => {  // BAD — deeply nested
      callback(result);
    });
  });
});

// GOOD — async/await
const user = await getUser(id);
const orders = await getOrders(user.id);
const result = await processOrders(orders);
```

---

## Category 5 — Design Issues

```python
# DESIGN — Controller doing DB work directly (violates layering)
@router.post("/items")
async def create_item(data: ItemCreate, db: AsyncSession = Depends(get_db)):
    # BAD — business logic and DB in route handler
    existing = await db.execute(select(Item).where(Item.name == data.name))
    if existing.scalar():
        raise HTTPException(409, "Exists")
    item = Item(**data.model_dump())
    db.add(item)
    await db.commit()
    return item

# GOOD — delegate to service → crud
@router.post("/items")
async def create_item(data: ItemCreate, service: ItemService = Depends()):
    return await service.create(data, org_id=current_user.org_id)

# DESIGN — Tight coupling to implementation
class OrderService:
    def __init__(self):
        self.db = PostgresDB()          # BAD — hardcoded, untestable

class OrderService:
    def __init__(self, db: AsyncSession):  # GOOD — injected, testable
        self.db = db
```

---

## Review Output Template

After reviewing, output:

```
SUMMARY
Total issues found: X (Y critical, Z high, ...)

ISSUES
1. LINE 42: BUG — Missing await on async DB call
   Found:   item = get_item(id)
   Problem: get_item is async — returns coroutine, not result
   Fixed:   item = await get_item(id)

2. LINE 67: SECURITY — org_id from request body
   Found:   crud.create(db, data)  # data.org_id from body
   Problem: Attacker can set any org_id
   Fixed:   crud.create(db, data, org_id=current_user.org_id)

POSITIVE NOTES
- Good error handling in lines 10-25
- Proper use of transactions in save_order()
```

Execute for: {{USER_REQUEST}}
