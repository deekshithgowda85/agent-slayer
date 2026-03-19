---
mode: 'agent'
tools: ['codebase']
description: 'Debug errors, read stack traces, and fix issues in Python, JavaScript, and Java applications'
---

# Debug & Fix — Error Analysis Guide

## Step 0 — Read the Error Completely
Before touching any code:
1. Read the FULL error message and stack trace — not just the first line
2. Identify the exact file and line number where the error originates
3. Distinguish between where the error is THROWN vs where it's TRIGGERED
4. Read the surrounding code (10 lines above and below the error line)
5. Check recent git changes that might have introduced the bug

---

## Reading Stack Traces

### Python Stack Trace
```
Traceback (most recent call last):         ← read from BOTTOM up
  File "main.py", line 45, in <module>    ← entry point (top of call stack)
    result = process_order(order_id)
  File "services/order.py", line 23, in process_order
    user = get_user(order.user_id)         ← intermediate call
  File "crud.py", line 67, in get_user
    return db.query(User).filter(          ← where error actually is ←
           User.id == user_id).first()
AttributeError: 'NoneType' object has no attribute 'id'  ← the actual error
```
**Reading guide:** The error is `AttributeError` on `order.user_id` — meaning `order` is `None`. The bug is in `process_order` line 23 — `order` was not found before accessing `.user_id`.

### JavaScript Stack Trace
```
TypeError: Cannot read properties of undefined (reading 'orgId')
    at createItem (services/item.service.js:34:28)   ← error here
    at async itemController.create (controllers/item.js:12:18)
    at async Layer.handle [as handle_request] (express/lib/router/layer.js)
```
**Reading guide:** `orgId` is being read from `undefined`. At `item.service.js:34` — check what variable is undefined. Likely `req.user` is undefined (missing auth middleware).

### Java Stack Trace
```
java.lang.NullPointerException: Cannot invoke "User.getOrgId()" because "user" is null
    at com.app.service.ItemService.create(ItemService.java:45)   ← error here
    at com.app.controller.ItemController.create(ItemController.java:23)
    at java.base/jdk.internal.reflect.NativeMethodAccessorImpl.invoke0(Native Method)
```
**Reading guide:** `user` is null at `ItemService.java:45`. Check how `user` is retrieved — likely `SecurityContextHolder.getContext().getAuthentication().getPrincipal()` returned null because the endpoint isn't protected.

---

## Common Errors — Diagnosis & Fix

### Python

#### AttributeError: 'NoneType' object has no attribute 'X'
```python
# DIAGNOSIS: You're calling .X on something that is None
# Common causes: DB query returned None, missing null check, optional field not set

# Pattern that causes it:
user = db.query(User).filter(User.id == user_id).first()  # returns None if not found
print(user.email)  # ← AttributeError here

# FIX:
user = db.query(User).filter(User.id == user_id).first()
if not user:
    raise HTTPException(status_code=404, detail="User not found")
print(user.email)  # safe now
```

#### TypeError: object is not subscriptable / not iterable
```python
# DIAGNOSIS: Treating None or wrong type as a list/dict

result = db.execute(query)    # result is a Result object, not a list
for item in result:           # might work but...
    print(item["id"])         # ← TypeError — Row accessed wrong way

# FIX:
result = db.execute(query)
for row in result.mappings():    # .mappings() gives dict-like access
    print(row["id"])
# OR
items = result.scalars().all()   # returns list of model objects
```

#### asyncio errors: "coroutine was never awaited"
```python
# DIAGNOSIS: Async function called without await

async def get_user(id): ...

user = get_user(user_id)         # BAD — user is a coroutine object!
user = await get_user(user_id)   # GOOD

# If you see: RuntimeWarning: coroutine 'get_user' was never awaited
# Find every call to async functions and add await
```

#### SQLAlchemy: DetachedInstanceError
```python
# DIAGNOSIS: Accessing lazy-loaded relationship after session closed

async def get_user(db, user_id):
    user = await db.get(User, user_id)
    return user                        # session closes here

user = await get_user(db, user_id)
print(user.orders)                     # ← DetachedInstanceError — session gone

# FIX: Eager load relationships you need
from sqlalchemy.orm import selectinload
result = await db.execute(
    select(User).options(selectinload(User.orders)).where(User.id == user_id)
)
user = result.scalar_one_or_none()
# Now user.orders is available after session closes
```

#### Pydantic ValidationError
```python
# DIAGNOSIS: Input data doesn't match schema

# Error: pydantic_core._pydantic_core.ValidationError: 1 validation error for ItemCreate
#   name: String should have at least 1 character [type=string_too_short]

# FIX: Check where data comes from — is it from request body, DB, or config?
# Add default or validator:
class ItemCreate(BaseModel):
    name: str = Field(..., min_length=1, description="Must not be empty")
    
    @field_validator('name')
    @classmethod
    def strip_whitespace(cls, v):
        v = v.strip()
        if not v:
            raise ValueError('Name cannot be blank')
        return v
```

---

### JavaScript

#### TypeError: Cannot read properties of undefined/null
```javascript
// DIAGNOSIS: Accessing property on undefined/null
// Most common: req.user is undefined (auth middleware missing or order wrong)

router.post('/items', itemController.create);          // BAD — no auth
router.post('/items', authenticate, itemController.create); // GOOD — auth first

// In controller:
const orgId = req.user?.orgId;          // optional chaining — safe
if (!orgId) return res.status(401).json({ error: 'Unauthorized' });
```

#### UnhandledPromiseRejection
```javascript
// DIAGNOSIS: async error not caught

router.get('/items', async (req, res) => {
  const items = await service.list();   // if this throws → UnhandledPromiseRejection
  res.json(items);
});

// FIX 1: try/catch
router.get('/items', async (req, res) => {
  try {
    const items = await service.list();
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// FIX 2: asyncHandler wrapper (cleaner)
const asyncHandler = fn => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

router.get('/items', asyncHandler(async (req, res) => {
  const items = await service.list();
  res.json(items);
}));
```

#### Prisma errors
```javascript
// P2002: Unique constraint violation
catch (err) {
  if (err.code === 'P2002') {
    throw { status: 409, message: `${err.meta?.target} already exists` };
  }
}

// P2025: Record not found (on update/delete)
catch (err) {
  if (err.code === 'P2025') {
    throw { status: 404, message: 'Record not found' };
  }
}

// P2003: Foreign key constraint
catch (err) {
  if (err.code === 'P2003') {
    throw { status: 400, message: 'Referenced record does not exist' };
  }
}
```

#### CORS errors (in browser)
```
Access to fetch at 'http://api.example.com' from origin 'http://app.example.com'
has been blocked by CORS policy
```
```javascript
// FIX: Add CORS middleware BEFORE routes
const cors = require('cors');
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Authorization', 'Content-Type'],
}));
// CRITICAL: cors() must be before app.use('/api', routes)
```

---

### Java

#### NullPointerException
```java
// DIAGNOSIS: Most common in Java — check with enhanced NPE message (Java 14+)
// "Cannot invoke "User.getOrgId()" because "user" is null"
// → user itself is null

// FIX: Use Optional
Optional<User> userOpt = repo.findById(userId);
if (userOpt.isEmpty()) throw new ResponseStatusException(NOT_FOUND, "User not found");
User user = userOpt.get();

// Or with orElseThrow (cleaner):
User user = repo.findById(userId)
    .orElseThrow(() -> new ResponseStatusException(NOT_FOUND, "User not found"));
```

#### LazyInitializationException (Hibernate)
```java
// DIAGNOSIS: Accessing lazy collection outside a transaction/session
// "org.hibernate.LazyInitializationException: failed to lazily initialize a collection"

// FIX 1: Add @Transactional to service method
@Transactional
public UserResponse getUser(UUID id) {
  User user = repo.findById(id).orElseThrow(...);
  user.getOrders().size(); // now within transaction — safe
  return mapper.map(user, UserResponse.class);
}

// FIX 2: Fetch join in query
@Query("SELECT u FROM User u LEFT JOIN FETCH u.orders WHERE u.id = :id")
Optional<User> findByIdWithOrders(@Param("id") UUID id);

// FIX 3: Use DTO projection instead of entity
@Query("SELECT new com.app.dto.UserSummary(u.id, u.name, COUNT(o)) 
        FROM User u LEFT JOIN u.orders o WHERE u.id = :id GROUP BY u.id")
Optional<UserSummary> findSummaryById(@Param("id") UUID id);
```

#### DataIntegrityViolationException
```java
// DIAGNOSIS: DB constraint violated (unique, FK, NOT NULL)
try {
  return repo.save(entity);
} catch (DataIntegrityViolationException e) {
  String msg = e.getMostSpecificCause().getMessage();
  if (msg.contains("unique") || msg.contains("duplicate")) {
    throw new ResponseStatusException(CONFLICT, "Record already exists");
  }
  if (msg.contains("foreign key")) {
    throw new ResponseStatusException(BAD_REQUEST, "Referenced record not found");
  }
  throw new ResponseStatusException(INTERNAL_SERVER_ERROR, "Database error");
}
```

---

## Debugging Workflow

```
1. READ full error + stack trace
2. IDENTIFY exact file + line number
3. READ that code + 10 lines around it
4. ASK: What value is unexpected here? (null? wrong type? wrong state?)
5. TRACE backwards: where does that value come from?
6. FIX the root cause — not the symptom
7. ADD null check / error handling at the source
8. WRITE a test that reproduces the bug
9. VERIFY fix makes test pass
10. CHECK if same bug pattern exists elsewhere
```

Execute for: {{USER_REQUEST}}
