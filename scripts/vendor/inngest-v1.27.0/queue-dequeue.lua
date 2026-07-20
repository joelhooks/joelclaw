-- Vendored from github.com/inngest/inngest v1.27.0 (commit 781c91d3c5c21852e84ee575d6d36b1ad9dcde1a).
-- Source: pkg/execution/state/redis_state/lua/queue/dequeue.lua with v1.27.0 includes expanded.
-- Do not edit independently of scripts/inngest-v127-purge.ts.

--[[

Output:
  0: Successfully dequeued item
  1: Queue item not found

]]

local keyQueueMap              = KEYS[1]
local keyPartitionMap          = KEYS[2]

local keyScavengerEntrypoint   = KEYS[3]

local keyReadyQueue            = KEYS[4]  -- queue:sorted:$workflowID - zset
local keyGlobalPointer         = KEYS[5]
local keyGlobalAccountPointer  = KEYS[6]           -- accounts:sorted - zset
local keyAccountPartitions     = KEYS[7]           -- accounts:$accountID:partition:sorted - zset

local keyShadowPartitionMeta             = KEYS[8]
local keyBacklogMeta                     = KEYS[9]

local keyBacklogSet                      = KEYS[10]
local keyShadowPartitionSet              = KEYS[11]
local keyGlobalShadowPartitionSet        = KEYS[12]
local keyGlobalAccountShadowPartitionSet = KEYS[13]
local keyAccountShadowPartitionSet       = KEYS[14]
local keyPartitionNormalizeSet           = KEYS[15]

local keyIdempotency           = KEYS[16]
local singletonRunKey          = KEYS[17]

local keyPartitionScavengerIndex  = KEYS[18]

local keyItemIndexA            = KEYS[19]   -- custom item index 1
local keyItemIndexB            = KEYS[20]  -- custom item index 2

local queueID        = ARGV[1]
local partitionID    = ARGV[2]
local backlogID      = ARGV[3]
local accountID      = ARGV[4]
local runID          = ARGV[5]
local idempotencyTTL = tonumber(ARGV[6])

-- gets a decoded queue item
local function get_queue_item(queueKey, queueID)
	local fetched = redis.call("HGET", queueKey, queueID)
	if fetched ~= false then
		return cjson.decode(fetched)
	end
	return nil
end

-- gets a decoded partition item
local function get_partition_item(partitionKey, id)
	local fetched = redis.call("HGET", partitionKey, id)
	if fetched ~= false then
		return cjson.decode(fetched)
	end
	return nil
end

local function get_shadow_partition_item(keyShadowPartitionMetaHash, id)
	local fetched = redis.call("HGET", keyShadowPartitionMetaHash, id)
	if fetched ~= false then
		return cjson.decode(fetched)
	end
	return nil
end

-- This function updates a function's place in the pointer queue to the given
-- score.  This score should almost always be the value from `get_fn_partition_score`.
-- It's a separate function as > 1 pointer queue may be updated at a time.
local function update_pointer_score_to(fnID, pointerQueueKey, updateTo)
    -- Only update if set.
    if updateTo > 0 then
        redis.call("ZADD", pointerQueueKey, updateTo, fnID)
    end
end

-- get_converted_earliest_pointer_score returns a high-precision queue's earliest job as a score for pointer queues.
-- Note: This operation converts high-precision item scores to lower-precision pointer scores. DO NOT USE FOR FUNCTION QUEUES.
-- This returns 0 if there are no scores available.
local function get_converted_earliest_pointer_score(keyQueueSet)
    local earliestScore = redis.call("ZRANGE", keyQueueSet, "-inf", "+inf", "BYSCORE", "LIMIT", 0, 1, "WITHSCORES")
    if earliestScore == nil or earliestScore == false or earliestScore[2] == nil then
        return 0
    end
    -- queues are ordered by ms precision, whereas pointers are second precision.
    -- earliest is a table containing {item, score}
    return math.floor(tonumber(earliestScore[2]) / 1000)
end


-- get_earliest_pointer_score returns a pointer queue's earlies score. This is usually a timestamp in second precision.
-- Note: NEVER use this for high-precision scores found in function queues. This may only be used for other pointer queues.
-- This returns 0 if there are no scores available.
local function get_earliest_pointer_score(keyPointerQueueSet)
    local earliestScore = redis.call("ZRANGE", keyPointerQueueSet, "-inf", "+inf", "BYSCORE", "LIMIT", 0, 1, "WITHSCORES")
    if earliestScore == nil or earliestScore == false or earliestScore[2] == nil then
        return 0
    end
    -- queues are ordered by ms precision, whereas pointers are second precision.
    -- earliest is a table containing {item, score}
    return tonumber(earliestScore[2])
end

-- get_earliest_score returns the earliest score in a given set.
local function get_earliest_score(keyQueueSet)
    local earliestScore = redis.call("ZRANGE", keyQueueSet, "-inf", "+inf", "BYSCORE", "LIMIT", 0, 1, "WITHSCORES")
    if earliestScore == nil or earliestScore == false or earliestScore[2] == nil then
        return 0
    end
    -- earliest is a table containing {item, score}
    return tonumber(earliestScore[2])
end

local function ends_with(str, ending)
   return ending == "" or str:sub(-#ending) == ending
end

-- used to ensure that keys don't terminate in a specific string, but still exist.
local function exists_without_ending(str, ending)
   return str ~= "" and str ~= nil and ends_with(str, ending) == false
end

local function account_is_set(keyAccountPartitions)
  return exists_without_ending(keyAccountPartitions, "accounts:00000000-0000-0000-0000-000000000000:partition:sorted") == true
end


-- This function updates account queues
-- Requires: update_pointer_score.lua, ends_with.lua
local function update_account_queues(keyGlobalAccountPointer, keyAccountPartitions, partitionID, accountId, score)
  -- we might be leasing an "old" partition which doesn't store the account
  if account_is_set(keyAccountPartitions) == true then
    update_pointer_score_to(partitionID, keyAccountPartitions, score)

    -- Upsert global accounts to _earliest_ score
    local earliestPartitionScoreInAccount = get_earliest_pointer_score(keyAccountPartitions)
    update_pointer_score_to(accountId, keyGlobalAccountPointer, earliestPartitionScoreInAccount)
  end
end

-- This function updates account shadow partition queues
-- Requires: update_pointer_score.lua, ends_with.lua
local function update_account_shadow_queues(keyGlobalAccountShadowPartitionSet, keyAccountShadowPartitionSet, partitionID, accountID, score)
  -- we might be leasing a system partition which doesn't store the account
  if exists_without_ending(keyAccountShadowPartitionSet, ":-") == true then
    update_pointer_score_to(partitionID, keyAccountShadowPartitionSet, score)

    -- Upsert global accounts to _earliest_ score
    local earliestPartitionScoreInAccount = get_earliest_score(keyAccountShadowPartitionSet)
    update_pointer_score_to(accountID, keyGlobalAccountShadowPartitionSet, earliestPartitionScoreInAccount)
  end
end

local function updateBacklogPointer(keyShadowPartitionMeta, keyBacklogMeta, keyGlobalShadowPartitionSet, keyGlobalAccountShadowPartitionSet, keyAccountShadowPartitionSet, keyShadowPartitionSet, keyBacklogSet, keyPartitionNormalizeSet, accountID, partitionID, backlogID)
  -- Retrieve the earliest item score in the backlog in milliseconds
  local earliestBacklogScore = get_earliest_score(keyBacklogSet)

  -- If backlog is empty, update dangling pointers in shadow partition
  if earliestBacklogScore == 0 then
    -- Remove meta
    redis.call("HDEL", keyBacklogMeta, backlogID)

    redis.call("ZREM", keyShadowPartitionSet, backlogID)

    -- If shadow partition has no more backlogs, update global/account pointers
    if tonumber(redis.call("ZCARD", keyShadowPartitionSet)) == 0 then
      -- Remove meta, only if no more async normalizations are due
      if tonumber(redis.call("ZCARD", keyPartitionNormalizeSet)) == 0 then
        redis.call("HDEL", keyShadowPartitionMeta, partitionID)
      end

      redis.call("ZREM", keyGlobalShadowPartitionSet, partitionID)
      redis.call("ZREM", keyAccountShadowPartitionSet, partitionID)

      if tonumber(redis.call("ZCARD", keyAccountShadowPartitionSet)) == 0 then
        redis.call("ZREM", keyGlobalAccountShadowPartitionSet, accountID)
      end
    end

    return
  end

  -- If backlog has more items, update pointer in shadow partition
  update_pointer_score_to(backlogID, keyShadowPartitionSet, earliestBacklogScore)

  -- In case the backlog is the new earliest item in the shadow partition,
  -- update pointers to shadow partition in global indexes
  local earliestShadowPartitionScore = get_earliest_score(keyShadowPartitionSet)

  -- Push back shadow partition in global set
  update_pointer_score_to(partitionID, keyGlobalShadowPartitionSet, earliestShadowPartitionScore)

  -- Push back shadow partition in account set + potentially push back account in global accounts set
  update_account_shadow_queues(keyGlobalAccountShadowPartitionSet, keyAccountShadowPartitionSet, partitionID, accountID, earliestShadowPartitionScore)
end


--
-- Fetch this item to see if it was in progress prior to deleting.
local item = get_queue_item(keyQueueMap, queueID)
if item == nil then
	return 1
end

redis.call("HDEL", keyQueueMap, queueID)

-- TODO Are these calls safe? Should we check for present keys?
redis.call("ZREM", keyReadyQueue, queueID)

if idempotencyTTL > 0 then
	redis.call("SETEX", keyIdempotency, idempotencyTTL, "")
end

-- Remove item from scavenger index
redis.call("ZREM", keyPartitionScavengerIndex, queueID)

-- Get the earliest item in the new scavenger index and old partition concurrency set.  We may be dequeueing
-- the only in-progress job and should remove this from the partition concurrency
-- pointers, if this exists.
--
-- This ensures that scavengeres have updated pointer queues without the currently
-- leased job, if exists.
local scavengerIndexScores = redis.call("ZRANGE", keyPartitionScavengerIndex, "-inf", "+inf", "BYSCORE", "LIMIT", 0, 1, "WITHSCORES")
if scavengerIndexScores == false or scavengerIndexScores == nil or #scavengerIndexScores == 0 then
  redis.call("ZREM", keyScavengerEntrypoint, partitionID)
else
  local earliestLease = tonumber(scavengerIndexScores[2])

  -- Ensure that we update the score with the earliest lease
  redis.call("ZADD", keyScavengerEntrypoint, earliestLease, partitionID)
end

-- For each partition, we now have an extra available capacity.  Check the partition's
-- score, and ensure that it's updated in the global pointer index.
--
local minScores = redis.call("ZRANGE", keyReadyQueue, "-inf", "+inf", "BYSCORE", "LIMIT", 0, 1, "WITHSCORES")
if minScores ~= nil and minScores ~= false and #minScores ~= 0 then
  -- If there's nothing int he partition set (no more jobs), end early, as we don't need to
  -- check partition scores.
  local currentScore = redis.call("ZSCORE", keyGlobalPointer, partitionID)
  if currentScore ~= nil and currentScore ~= false then
    local earliestScore = tonumber(minScores[2])/1000
      if tonumber(currentScore) > earliestScore then
        -- Update the global index now that there's capacity, even if we've forced, as we now
        -- have capacity.  Note the earliest score is in MS while partitions are stored in S.
        update_pointer_score_to(partitionID, keyGlobalPointer, earliestScore)
        update_account_queues(keyGlobalAccountPointer, keyAccountPartitions, partitionID, accountID, earliestScore)

        -- Clear the ForceAtMS from the pointer.
        local existing = get_partition_item(keyPartitionMap, partitionID)
        existing.forceAtMS = nil
        redis.call("HSET", keyPartitionMap, partitionID, cjson.encode(existing))
      end
  end
end

-- Add optional indexes.
if keyItemIndexA ~= "" and keyItemIndexA ~= false and keyItemIndexA ~= nil then
	redis.call("ZREM", keyItemIndexA, queueID)
end
if keyItemIndexB ~= "" and keyItemIndexB ~= false and keyItemIndexB ~= nil then
	redis.call("ZREM", keyItemIndexB, queueID)
end

-- If item is in backlog, remove
local backlogScore = tonumber(redis.call("ZSCORE", keyBacklogSet, queueID))
if backlogScore ~= nil and backlogScore ~= false and backlogScore > 0 then
  redis.call("ZREM", keyBacklogSet, queueID)

  -- update backlog pointers
  updateBacklogPointer(keyShadowPartitionMeta, keyBacklogMeta, keyGlobalShadowPartitionSet, keyGlobalAccountShadowPartitionSet, keyAccountShadowPartitionSet, keyShadowPartitionSet, keyBacklogSet, keyPartitionNormalizeSet, accountID, partitionID, backlogID)
end


-- Remove singleton lock
local singletonKey = redis.call("GET", singletonRunKey)

if singletonKey ~= nil and singletonKey ~= false and keyItemIndexA ~= "" and keyItemIndexA ~= false and keyItemIndexA ~= nil then
  local queueItemsCount = redis.call("ZCOUNT", keyItemIndexA, "-inf", "+inf")
  local singletonRunID = redis.call("GET", singletonKey)

  if tonumber(queueItemsCount) == 0 then
    -- We just dequeued the last step
     redis.call("DEL", singletonRunKey)

     if singletonRunID == runID then
        redis.call("DEL", singletonKey)
    end
  end
end

return 0
