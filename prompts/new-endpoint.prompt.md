---
mode: 'agent'
tools: ['codebase']
description: 'Create a new API endpoint in Python (FastAPI/Django/Flask), JavaScript (Express/Node), or Java (Spring Boot)'
---

# New API Endpoint — Full Build Guide

## Step 0 — Read Codebase First
Before writing anything:
- Scan `main.py` / `app.py` / `app.js` / `Application.java` to understand project entry point
- Read existing router/controller files to match naming conventions already used
- Check existing schema/model files to match patterns (snake_case vs camelCase, UUID vs int IDs)
- Read `requirements.txt` / `package.json` / `pom.xml` to know available libraries
- Never assume — always read before writing

---

## Python — FastAPI

### Step 1 — Pydantic Schema (`schemas/`)
```python
from pydantic import BaseModel, Field, validator
from uuid import UUID
from typing import Optional
from datetime import datetime

class ItemCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=255, description="Item name")
    description: Optional[str] = Field(None, max_length=1000)
    
    @validator('name')
    def name_must_not_be_blank(cls, v):
        if not v.strip():
            raise ValueError('Name cannot be blank or whitespace')
        return v.strip()

class ItemResponse(BaseModel):
    id: UUID
    name: str
    org_id: UUID
    created_at: datetime
    
    class Config:
        from_attributes = True
```

### Step 2 — SQLAlchemy Model (`models/`) — only if new table needed
```python
from sqlalchemy import Column, String, DateTime, Index
from sqlalchemy.dialects.postgresql import UUID
import uuid
from datetime import datetime
from db import Base

class Item(Base):
    __tablename__ = "items"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id = Column(UUID(as_uuid=True), nullable=False, index=True)  # always index
    name = Column(String(255), nullable=False)
    description = Column(String(1000), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        Index('ix_items_org_id_created', 'org_id', 'created_at'),  # composite for common queries
    )
```

### Step 3 — CRUD (`crud.py`)
```python
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, update, delete
from fastapi import HTTPException
from uuid import UUID
from models import Item
from schemas import ItemCreateRequest

async def create_item(db: AsyncSession, data: ItemCreateRequest, org_id: UUID) -> Item:
    item = Item(**data.model_dump(), org_id=org_id)
    db.add(item)
    try:
        await db.commit()
        await db.refresh(item)
    except Exception as e:
        await db.rollback()
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")
    return item

async def get_item(db: AsyncSession, item_id: UUID, org_id: UUID) -> Item:
    result = await db.execute(
        select(Item)
        .where(Item.id == item_id)
        .where(Item.org_id == org_id)  # ALWAYS scope by org
    )
    item = result.scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    return item

async def list_items(db: AsyncSession, org_id: UUID, skip: int = 0, limit: int = 50) -> list[Item]:
    result = await db.execute(
        select(Item)
        .where(Item.org_id == org_id)
        .offset(skip).limit(min(limit, 100))  # cap at 100
        .order_by(Item.created_at.desc())
    )
    return result.scalars().all()
```

### Step 4 — Router (`routers/`)
```python
from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession
from uuid import UUID
from db import get_db
from auth import get_current_user, CurrentUser
import crud, schemas

router = APIRouter(prefix="/items", tags=["Items"])

@router.post("/", response_model=schemas.ItemResponse, status_code=status.HTTP_201_CREATED)
async def create_item(
    data: schemas.ItemCreateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = Depends(get_current_user)
):
    """Create a new item. org_id is always from JWT, never from request body."""
    return await crud.create_item(db, data, org_id=current_user.org_id)

@router.get("/{item_id}", response_model=schemas.ItemResponse)
async def get_item(
    item_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = Depends(get_current_user)
):
    return await crud.get_item(db, item_id, org_id=current_user.org_id)

@router.get("/", response_model=list[schemas.ItemResponse])
async def list_items(
    skip: int = 0,
    limit: int = 20,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = Depends(get_current_user)
):
    return await crud.list_items(db, org_id=current_user.org_id, skip=skip, limit=limit)
```

### Step 5 — Register in `main.py`
```python
from routers import items
app.include_router(items.router, prefix="/api/v1")
```

---

## JavaScript — Express/Node

### Step 1 — Validation Schema (`validators/`)
```javascript
// validators/item.validator.js
const Joi = require('joi');

const createItemSchema = Joi.object({
  name: Joi.string().min(1).max(255).trim().required()
    .messages({ 'string.empty': 'Name cannot be blank' }),
  description: Joi.string().max(1000).optional().allow(null, ''),
});

const validateCreate = (req, res, next) => {
  const { error, value } = createItemSchema.validate(req.body, { abortEarly: false });
  if (error) {
    return res.status(422).json({
      error: 'Validation failed',
      code: 422,
      detail: error.details.map(d => d.message)
    });
  }
  req.body = value; // use sanitized value
  next();
};

module.exports = { validateCreate };
```

### Step 2 — Model (`models/`)
```javascript
// models/Item.js (Prisma schema or Mongoose)
// Prisma:
// model Item {
//   id          String   @id @default(uuid())
//   orgId       String
//   name        String   @db.VarChar(255)
//   description String?  @db.VarChar(1000)
//   createdAt   DateTime @default(now())
//   updatedAt   DateTime @updatedAt
//   @@index([orgId])
// }
```

### Step 3 — Service (`services/`)
```javascript
// services/item.service.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function createItem(data, orgId) {
  try {
    return await prisma.item.create({
      data: { ...data, orgId },
      select: { id: true, name: true, orgId: true, createdAt: true }
    });
  } catch (err) {
    if (err.code === 'P2002') throw { status: 409, message: 'Item already exists' };
    throw { status: 500, message: 'Database error', detail: err.message };
  }
}

async function getItem(id, orgId) {
  const item = await prisma.item.findFirst({
    where: { id, orgId }  // always scope by orgId
  });
  if (!item) throw { status: 404, message: 'Item not found' };
  return item;
}

module.exports = { createItem, getItem };
```

### Step 4 — Controller + Router (`routes/`)
```javascript
// routes/item.routes.js
const express = require('express');
const router = express.Router();
const itemService = require('../services/item.service');
const { validateCreate } = require('../validators/item.validator');
const { authenticate } = require('../middleware/auth');

router.use(authenticate); // protect all routes in this file

router.post('/', validateCreate, async (req, res) => {
  try {
    const item = await itemService.createItem(req.body, req.user.orgId);
    res.status(201).json(item);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, code: err.status || 500, detail: err.detail || null });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const item = await itemService.getItem(req.params.id, req.user.orgId);
    res.json(item);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, code: err.status || 500 });
  }
});

module.exports = router;
```

### Step 5 — Register in `app.js`
```javascript
const itemRoutes = require('./routes/item.routes');
app.use('/api/v1/items', itemRoutes);
```

---

## Java — Spring Boot

### Step 1 — DTO (`dto/`)
```java
// dto/ItemCreateRequest.java
import jakarta.validation.constraints.*;

public record ItemCreateRequest(
    @NotBlank(message = "Name cannot be blank")
    @Size(min = 1, max = 255, message = "Name must be 1-255 characters")
    String name,

    @Size(max = 1000)
    String description
) {}

// dto/ItemResponse.java
public record ItemResponse(UUID id, String name, UUID orgId, LocalDateTime createdAt) {}
```

### Step 2 — Entity (`entity/`)
```java
@Entity
@Table(name = "items", indexes = @Index(columnList = "org_id"))
public class Item {
    @Id @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;
    
    @Column(name = "org_id", nullable = false)
    private UUID orgId;
    
    @Column(nullable = false, length = 255)
    private String name;
    
    @CreationTimestamp
    private LocalDateTime createdAt;
}
```

### Step 3 — Repository (`repository/`)
```java
public interface ItemRepository extends JpaRepository<Item, UUID> {
    Optional<Item> findByIdAndOrgId(UUID id, UUID orgId); // always scope by orgId
    List<Item> findAllByOrgIdOrderByCreatedAtDesc(UUID orgId, Pageable pageable);
}
```

### Step 4 — Service (`service/`)
```java
@Service
@RequiredArgsConstructor
public class ItemService {
    private final ItemRepository repo;
    private final ModelMapper mapper;

    public ItemResponse create(ItemCreateRequest req, UUID orgId) {
        Item item = mapper.map(req, Item.class);
        item.setOrgId(orgId);
        return mapper.map(repo.save(item), ItemResponse.class);
    }

    public ItemResponse getById(UUID id, UUID orgId) {
        return repo.findByIdAndOrgId(id, orgId)
            .map(i -> mapper.map(i, ItemResponse.class))
            .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Item not found"));
    }
}
```

### Step 5 — Controller (`controller/`)
```java
@RestController
@RequestMapping("/api/v1/items")
@RequiredArgsConstructor
@Validated
public class ItemController {
    private final ItemService service;

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public ItemResponse create(@Valid @RequestBody ItemCreateRequest req,
                               @AuthenticationPrincipal JwtUser user) {
        return service.create(req, user.getOrgId());
    }

    @GetMapping("/{id}")
    public ItemResponse getById(@PathVariable UUID id,
                                @AuthenticationPrincipal JwtUser user) {
        return service.getById(id, user.getOrgId());
    }
}
```

---

## Error Correction Checklist — Run Before Finishing
- [ ] org_id comes from JWT/auth context, never from request body
- [ ] All DB writes wrapped in try/catch with rollback
- [ ] Input validation happens BEFORE any DB call
- [ ] 404 returned for missing resource (not 500)
- [ ] Response model never exposes internal fields (passwords, internal IDs)
- [ ] Pagination has a max cap (never unlimited queries)
- [ ] All routes protected by auth middleware/dependency

Execute for: {{USER_REQUEST}}
