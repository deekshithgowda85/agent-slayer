---
mode: 'agent'
tools: ['codebase']
description: 'Write safe, optimized, org-scoped database queries in Python (SQLAlchemy), JavaScript (Prisma/Knex), or Java (JPA/JDBC)'
---

# Database Query — Safety & Optimization Guide

## Step 0 — Read Before Writing
- Read existing query patterns in `crud.py` / `*.service.js` / `*Repository.java`
- Check what indexes exist — don't write queries that'll do full table scans
- Understand current transaction patterns used in the project
- Never add a new ORM library if one already exists

---

## Core Rules (All Languages)
1. **Always scope by org_id** — every query that touches user data must have `WHERE org_id = ?`
2. **Never SELECT *** — always name columns; avoids over-fetching and schema change breakage
3. **Always parameterize** — never f-strings, template literals, or string concat in SQL
4. **Handle None/null** — always check result before accessing fields
5. **Cap list queries** — always set a max LIMIT, never return unlimited rows
6. **Use indexes** — if querying a column often, it needs an index; mention it
7. **Wrap mutations in transactions** — multi-step writes must be atomic

---

## Python — SQLAlchemy (Async)

### Read — Single Record
```python
async def get_by_id(db: AsyncSession, record_id: UUID, org_id: UUID) -> Model:
    result = await db.execute(
        select(Model)
        .where(Model.id == record_id)
        .where(Model.org_id == org_id)   # org scope always
    )
    record = result.scalar_one_or_none()
    if not record:
        raise HTTPException(status_code=404, detail="Record not found")
    return record
```

### Read — List with Pagination
```python
async def list_records(
    db: AsyncSession, org_id: UUID,
    skip: int = 0, limit: int = 20,
    status: Optional[str] = None
) -> list[Model]:
    query = (
        select(Model)
        .where(Model.org_id == org_id)
        .order_by(Model.created_at.desc())
        .offset(skip)
        .limit(min(limit, 100))  # hard cap — never unlimited
    )
    if status:
        query = query.where(Model.status == status)
    result = await db.execute(query)
    return result.scalars().all()
```

### Read — Count (for limits/pagination)
```python
async def count_by_org(db: AsyncSession, org_id: UUID) -> int:
    result = await db.execute(
        select(func.count()).select_from(Model).where(Model.org_id == org_id)
    )
    return result.scalar_one()
```

### Read — Join (avoid N+1)
```python
# BAD — N+1 query (one query per item to get related data)
items = await db.execute(select(Item).where(Item.org_id == org_id))
for item in items.scalars():
    owner = await db.execute(select(User).where(User.id == item.user_id))  # N queries!

# GOOD — single query with join
result = await db.execute(
    select(Item, User)
    .join(User, Item.user_id == User.id)
    .where(Item.org_id == org_id)
    .options(selectinload(Item.user))  # or joinedload for to-one
)
```

### Write — Create
```python
async def create_record(db: AsyncSession, data: dict, org_id: UUID) -> Model:
    record = Model(**data, org_id=org_id)
    db.add(record)
    try:
        await db.commit()
        await db.refresh(record)
        return record
    except IntegrityError as e:
        await db.rollback()
        raise HTTPException(status_code=409, detail="Record already exists")
    except Exception as e:
        await db.rollback()
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")
```

### Write — Update (safe partial update)
```python
async def update_record(
    db: AsyncSession, record_id: UUID, org_id: UUID, updates: dict
) -> Model:
    # Fetch first to verify ownership
    record = await get_by_id(db, record_id, org_id)
    
    # Apply only provided fields
    for field, value in updates.items():
        if hasattr(record, field) and value is not None:
            setattr(record, field, value)
    
    try:
        await db.commit()
        await db.refresh(record)
        return record
    except Exception as e:
        await db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
```

### Write — Delete (soft delete preferred)
```python
# Soft delete (recommended — preserves audit trail)
async def delete_record(db: AsyncSession, record_id: UUID, org_id: UUID) -> None:
    record = await get_by_id(db, record_id, org_id)
    record.deleted_at = datetime.utcnow()
    await db.commit()

# Hard delete (only if truly needed)
async def hard_delete(db: AsyncSession, record_id: UUID, org_id: UUID) -> None:
    record = await get_by_id(db, record_id, org_id)
    await db.delete(record)
    await db.commit()
```

### Write — Transaction (multi-step atomic)
```python
async def transfer_ownership(
    db: AsyncSession, item_id: UUID, from_org: UUID, to_org: UUID
) -> None:
    async with db.begin():  # transaction — auto-rollback on exception
        item = await get_by_id(db, item_id, from_org)
        item.org_id = to_org
        await db.execute(
            update(AuditLog).values(transferred_at=datetime.utcnow())
            .where(AuditLog.item_id == item_id)
        )
        # both succeed or both roll back
```

---

## JavaScript — Prisma

### Read — Single
```javascript
async function getById(id, orgId) {
  const record = await prisma.model.findFirst({
    where: { id, orgId },                          // always scope by orgId
    select: { id: true, name: true, createdAt: true } // never select all
  });
  if (!record) throw { status: 404, message: 'Not found' };
  return record;
}
```

### Read — List with Pagination
```javascript
async function listRecords(orgId, { skip = 0, take = 20, status } = {}) {
  const where = { orgId, ...(status && { status }) };
  const [records, total] = await prisma.$transaction([
    prisma.model.findMany({
      where,
      select: { id: true, name: true, status: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      skip,
      take: Math.min(take, 100)                    // hard cap
    }),
    prisma.model.count({ where })
  ]);
  return { records, total, hasMore: skip + take < total };
}
```

### Write — Create with error handling
```javascript
async function createRecord(data, orgId) {
  try {
    return await prisma.model.create({
      data: { ...data, orgId },
      select: { id: true, name: true, orgId: true, createdAt: true }
    });
  } catch (err) {
    if (err.code === 'P2002') throw { status: 409, message: 'Already exists' };
    if (err.code === 'P2003') throw { status: 400, message: 'Invalid reference' };
    throw { status: 500, message: 'Database error', detail: err.message };
  }
}
```

### Write — Transaction
```javascript
async function transferOwnership(itemId, fromOrgId, toOrgId) {
  return await prisma.$transaction(async (tx) => {
    const item = await tx.item.findFirst({ where: { id: itemId, orgId: fromOrgId } });
    if (!item) throw { status: 404, message: 'Item not found' };
    
    const updated = await tx.item.update({ where: { id: itemId }, data: { orgId: toOrgId } });
    await tx.auditLog.create({ data: { itemId, fromOrgId, toOrgId, action: 'TRANSFER' } });
    return updated;                                // both commit or both rollback
  });
}
```

### Raw SQL (only when ORM insufficient)
```javascript
// Use $queryRaw with Prisma.sql template tag — never string concat
const results = await prisma.$queryRaw`
  SELECT id, name, created_at
  FROM items
  WHERE org_id = ${orgId}           -- parameterized
    AND created_at > ${cutoffDate}
  ORDER BY created_at DESC
  LIMIT ${Math.min(limit, 100)}
`;
```

---

## Java — Spring Data JPA

### Repository Interface
```java
public interface ModelRepository extends JpaRepository<Model, UUID> {
    // Spring generates safe parameterized queries from method names
    Optional<Model> findByIdAndOrgId(UUID id, UUID orgId);
    
    List<Model> findByOrgIdAndStatusOrderByCreatedAtDesc(
        UUID orgId, Status status, Pageable pageable);
    
    long countByOrgId(UUID orgId);
    
    // Custom JPQL for complex queries
    @Query("SELECT m FROM Model m WHERE m.orgId = :orgId AND m.createdAt > :since")
    List<Model> findRecentByOrg(@Param("orgId") UUID orgId, 
                                @Param("since") LocalDateTime since,
                                Pageable pageable);
}
```

### Service with Transaction
```java
@Service
@Transactional
public class ModelService {
    private final ModelRepository repo;
    
    public ModelResponse getById(UUID id, UUID orgId) {
        return repo.findByIdAndOrgId(id, orgId)
            .map(m -> mapper.map(m, ModelResponse.class))
            .orElseThrow(() -> new ResponseStatusException(NOT_FOUND, "Not found"));
    }
    
    public Page<ModelResponse> list(UUID orgId, Pageable pageable) {
        // Pageable already caps results — set max in controller
        return repo.findByOrgIdOrderByCreatedAtDesc(orgId, pageable)
            .map(m -> mapper.map(m, ModelResponse.class));
    }
    
    @Transactional  // atomic — rolls back on any exception
    public void transferOwnership(UUID itemId, UUID fromOrg, UUID toOrg) {
        Model item = repo.findByIdAndOrgId(itemId, fromOrg)
            .orElseThrow(() -> new ResponseStatusException(NOT_FOUND));
        item.setOrgId(toOrg);
        auditRepo.save(new AuditLog(itemId, fromOrg, toOrg));
        // both saved or both rolled back
    }
}
```

### Native SQL (when JPQL insufficient)
```java
@Query(
    value = """
        SELECT id, name, created_at
        FROM items
        WHERE org_id = :orgId
          AND created_at > :since
        ORDER BY created_at DESC
        LIMIT :limit
    """,
    nativeQuery = true
)
List<Object[]> findRecentNative(@Param("orgId") UUID orgId,
                                @Param("since") LocalDateTime since,
                                @Param("limit") int limit);
// Always use @Param — never string concatenation in native queries
```

---

## Index Strategy — When to Add

Add an index when:
- Column appears in WHERE clause frequently → single index
- Two columns appear together in WHERE → composite index `(org_id, status)`
- Column used in ORDER BY on large tables → index on that column
- Foreign key column → always index it

Never index: boolean columns, low-cardinality columns (status with 2 values)

```sql
-- Good indexes
CREATE INDEX idx_items_org_id ON items(org_id);
CREATE INDEX idx_items_org_created ON items(org_id, created_at DESC);

-- Unnecessary (low cardinality)
CREATE INDEX idx_items_is_deleted ON items(is_deleted);  -- BAD
```

---

## Error Correction Checklist
- [ ] Every query that touches user data has `org_id` filter
- [ ] No raw string concatenation in any SQL query
- [ ] All list queries have a hard LIMIT cap (max 100)
- [ ] Multi-step writes use transactions
- [ ] `IntegrityError` / `P2002` / constraint violations return 409 not 500
- [ ] `None` / `null` results raise 404, not AttributeError / NullPointerException
- [ ] Joins used instead of N+1 loops

Execute for: {{USER_REQUEST}}
