import {
  EntryPoint, IAccount__factory,
  IEntryPoint__factory,
  IPaymaster__factory, SenderCreator__factory
} from '@account-abstraction/contracts'
import { hexZeroPad, Interface, keccak256 } from 'ethers/lib/utils'
import { BundlerCollectorReturn } from './BundlerCollectorTracer'
import { mapOf, requireCond } from './utils'
import { inspect } from 'util'

import Debug from 'debug'
import { toBytes32 } from './modules/moduleUtils'
import { ValidationResult } from './modules/ValidationManager'
import { BigNumber, BigNumberish } from 'ethers'
import { TestOpcodesAccountFactory__factory, TestOpcodesAccount__factory, TestStorageAccount__factory } from './types'
import { StakeInfo, StorageMap, UserOperation, ValidationErrors } from './modules/Types'

const debug = Debug('aa.handler.opcodes')

interface CallEntry {
  to: string
  from: string
  type: string // call opcode
  method: string // parsed method, or signash if unparsed
  revert?: any // parsed output from REVERT
  return?: any // parsed method output.
  value?: BigNumberish
}

/**
 * parse all call operation in the trace.
 * notes:
 * - entries are ordered by the return (so nested call appears before its outer call
 * - last entry is top-level return from "simulateValidation". it as ret and rettype, but no type or address
 * @param tracerResults
 */
function parseCallStack (tracerResults: BundlerCollectorReturn): CallEntry[] {
  const abi = Object.values([
    ...TestOpcodesAccount__factory.abi,
    ...TestOpcodesAccountFactory__factory.abi,
    ...TestStorageAccount__factory.abi,
    ...SenderCreator__factory.abi,
    ...IEntryPoint__factory.abi,
    ...IPaymaster__factory.abi
  ].reduce((set, entry) => {
    const key = `${entry.name}(${entry.inputs.map(i => i.type).join(',')})`
    // console.log('key=', key, keccak256(Buffer.from(key)).slice(0,10))
    return {
      ...set,
      [key]: entry
    }
  }, {})) as any

  const xfaces = new Interface(abi)

  function callCatch<T, T1> (x: () => T, def: T1): T | T1 {
    try {
      return x()
    } catch {
      return def
    }
  }

  const out: CallEntry[] = []
  const stack: any[] = []
  const calls = tracerResults.callsFromEntryPoint.flatMap(level => level.calls)
  calls
    .filter(x => !x.type.startsWith('depth'))
    .forEach(c => {
      if (c.type.match(/REVERT|RETURN/) != null) {
        const top = stack.splice(-1)[0] ?? {
          type: 'top',
          method: 'validateUserOp'
        }
        const returnData: string = (c as any).data
        if (top.type.match(/CREATE/) != null) {
          out.push({
            to: top.to,
            from: top.from,
            type: top.type,
            method: '',
            return: `len=${returnData.length}`
          })
        } else {
          const method = callCatch(() => xfaces.getFunction(top.method), top.method)
          if (c.type === 'REVERT') {
            const parsedError = callCatch(() => xfaces.parseError(returnData), returnData)
            out.push({
              to: top.to,
              from: top.from,
              type: top.type,
              method: method.name,
              value: top.value,
              revert: parsedError
            })
          } else {
            const ret = callCatch(() => xfaces.decodeFunctionResult(method, returnData), returnData)
            out.push({
              to: top.to,
              from: top.from,
              type: top.type,
              method: method.name ?? method,
              return: ret
            })
          }
        }
      } else {
        stack.push(c)
      }
    })

  // TODO: verify that stack is empty at the end.

  return out
}

/**
 * slots associated with each entity.
 * keccak( A || ...) is associated with "A"
 * removed rule: keccak( ... || ASSOC ) (for a previously associated hash) is also associated with "A"
 *
 * @param stakeInfoEntities stake info for (factory, account, paymaster). factory and paymaster can be null.
 * @param keccak array of buffers that were given to keccak in the transaction
 */
function parseEntitySlots (stakeInfoEntities: { [addr: string]: StakeInfo | undefined }, keccak: string[]): { [addr: string]: Set<string> } {
  // for each entity (sender, factory, paymaster), hold the valid slot addresses
  // valid: the slot was generated by keccak(entity || ...)
  const entitySlots: { [addr: string]: Set<string> } = {}

  keccak.forEach(k => {
    Object.values(stakeInfoEntities).forEach(info => {
      const addr = info?.addr?.toLowerCase()
      if (addr == null) return
      const addrPadded = toBytes32(addr)
      if (entitySlots[addr] == null) {
        entitySlots[addr] = new Set<string>()
      }

      const currentEntitySlots = entitySlots[addr]

      // valid slot: the slot was generated by keccak(entityAddr || ...)
      if (k.startsWith(addrPadded)) {
        // console.log('added mapping (balance) slot', value)
        currentEntitySlots.add(keccak256(k))
      }
      // disabled 2nd rule: .. or by keccak( ... || OWN) where OWN is previous allowed slot
      // if (k.length === 130 && currentEntitySlots.has(k.slice(-64))) {
      //   // console.log('added double-mapping (allowance) slot', value)
      //   currentEntitySlots.add(value)
      // }
    })
  })

  return entitySlots
}

// method-signature for calls from entryPoint
const callsFromEntryPointMethodSigs: {[key: string]: string} = {
  factory: SenderCreator__factory.createInterface().getSighash('createSender'),
  account: IAccount__factory.createInterface().getSighash('validateUserOp'),
  paymaster: IPaymaster__factory.createInterface().getSighash('validatePaymasterUserOp')
}

/**
 * parse collected simulation traces and revert if they break our rules
 * @param userOp the userOperation that was used in this simulation
 * @param tracerResults the tracer return value
 * @param validationResult output from simulateValidation
 * @param entryPoint the entryPoint that hosted the "simulatedValidation" traced call.
 * @return list of contract addresses referenced by this UserOp
 */
export function parseScannerResult (userOp: UserOperation, tracerResults: BundlerCollectorReturn, validationResult: ValidationResult, entryPoint: EntryPoint): [string[], StorageMap] {
  debug('=== simulation result:', inspect(tracerResults, true, 10, true))
  // todo: block access to no-code addresses (might need update to tracer)

  const entryPointAddress = entryPoint.address.toLowerCase()

  const bannedOpCodes = new Set(['GASPRICE', 'GASLIMIT', 'DIFFICULTY', 'TIMESTAMP', 'BASEFEE', 'BLOCKHASH', 'NUMBER', 'SELFBALANCE', 'BALANCE', 'ORIGIN', 'GAS', 'CREATE', 'COINBASE', 'SELFDESTRUCT', 'RANDOM', 'PREVRANDAO'])

  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  if (Object.values(tracerResults.callsFromEntryPoint).length < 1) {
    throw new Error('Unexpected traceCall result: no calls from entrypoint.')
  }
  const callStack = parseCallStack(tracerResults)

  const callInfoEntryPoint = callStack.find(call =>
    call.to === entryPointAddress && call.from !== entryPointAddress &&
    (call.method !== '0x' && call.method !== 'depositTo'))
  requireCond(callInfoEntryPoint == null,
    `illegal call into EntryPoint during validation ${callInfoEntryPoint?.method}`,
    ValidationErrors.OpcodeValidation
  )

  requireCond(
    callStack.find(call => call.to !== entryPointAddress &&
      BigNumber.from(call.value ?? 0) !== BigNumber.from(0)) != null,
    'May not may CALL with value',
    ValidationErrors.OpcodeValidation)

  const sender = userOp.sender.toLowerCase()
  // stake info per "number" level (factory, sender, paymaster)
  // we only use stake info if we notice a memory reference that require stake
  const stakeInfoEntities = {
    factory: validationResult.factoryInfo,
    account: validationResult.senderInfo,
    paymaster: validationResult.paymasterInfo
  }

  const entitySlots: { [addr: string]: Set<string> } = parseEntitySlots(stakeInfoEntities, tracerResults.keccak)

  Object.entries(stakeInfoEntities).forEach(([entityTitle, entStakes]) => {
    const entityAddr = entStakes?.addr ?? ''
    const currentNumLevel = tracerResults.callsFromEntryPoint.find(info => info.topLevelMethodSig === callsFromEntryPointMethodSigs[entityTitle])
    if (currentNumLevel == null) {
      if (entityTitle === 'account') {
        // should never happen... only factory, paymaster are optional.
        throw new Error('missing trace into validateUserOp')
      }
      return
    }
    const opcodes = currentNumLevel.opcodes
    const access = currentNumLevel.access

    requireCond(!(currentNumLevel.oog ?? false),
      `${entityTitle} internally reverts on oog`, ValidationErrors.OpcodeValidation)
    Object.keys(opcodes).forEach(opcode =>
      requireCond(!bannedOpCodes.has(opcode), `${entityTitle} uses banned opcode: ${opcode}`, ValidationErrors.OpcodeValidation)
    )
    if (entityTitle === 'factory') {
      requireCond((opcodes.CREATE2 ?? 0) <= 1, `${entityTitle} with too many CREATE2`, ValidationErrors.OpcodeValidation)
    } else {
      requireCond(opcodes.CREATE2 == null, `${entityTitle} uses banned opcode: CREATE2`, ValidationErrors.OpcodeValidation)
    }

    Object.entries(access).forEach(([addr, {
      reads,
      writes
    }]) => {
      // testing read/write access on contract "addr"
      if (addr === sender) {
        // allowed to access sender's storage
        return
      }
      if (addr === entryPointAddress) {
        // ignore storage access on entryPoint (balance/deposit of entities.
        // we block them on method calls: only allowed to deposit, never to read
        return
      }

      // return true if the given slot is associated with the given address, given the known keccak operations:
      // @param slot the SLOAD/SSTORE slot address we're testing
      // @param addr - the address we try to check for association with
      // @param reverseKeccak - a mapping we built for keccak values that contained the address
      function associatedWith (slot: string, addr: string, entitySlots: { [addr: string]: Set<string> }): boolean {
        const addrPadded = hexZeroPad(addr, 32).toLowerCase()
        if (slot === addrPadded) {
          return true
        }
        const k = entitySlots[addr]
        if (k == null) {
          return false
        }
        const slotN = BigNumber.from(slot)
        // scan all slot entries to check of the given slot is within a structure, starting at that offset.
        // assume a maximum size on a (static) structure size.
        for (const k1 of k.keys()) {
          const kn = BigNumber.from(k1)
          if (slotN.gte(kn) && slotN.lt(kn.add(128))) {
            return true
          }
        }
        return false
      }

      debug('dump keccak calculations and reads', {
        entityTitle,
        entityAddr,
        k: mapOf(tracerResults.keccak, k => keccak256(k)),
        reads
      })

      // scan all slots. find a referenced slot
      // at the end of the scan, we will check if the entity has stake, and report that slot if not.
      let requireStakeSlot: string | undefined
      [...Object.keys(writes), ...Object.keys(reads)].forEach(slot => {
        // slot associated with sender is allowed (e.g. token.balanceOf(sender)
        // but during initial UserOp (where there is an initCode), it is allowed only for staked entity
        if (associatedWith(slot, sender, entitySlots)) {
          if (userOp.initCode.length > 2) {
            requireStakeSlot = slot
          }
        } else if (associatedWith(slot, entityAddr, entitySlots)) {
          // accessing a slot associated with entityAddr (e.g. token.balanceOf(paymaster)
          requireStakeSlot = slot
        } else if (addr === entityAddr) {
          // accessing storage member of entity itself requires stake.
          requireStakeSlot = slot
        } else {
          // accessing arbitrary storage of another contract is not allowed
          const readWrite = Object.keys(writes).includes(addr) ? 'write to' : 'read from'
          requireCond(false,
            `${entityTitle} has forbidden ${readWrite} ${nameAddr(addr, entityTitle)} slot ${slot}`,
            ValidationErrors.OpcodeValidation, { [entityTitle]: entStakes?.addr })
        }
      })

      // if addr is current account/paymaster/factory, then return that title
      // otherwise, return addr as-is
      function nameAddr (addr: string, currentEntity: string): string {
        const [title] = Object.entries(stakeInfoEntities).find(([title, info]) =>
          info?.addr.toLowerCase() === addr.toLowerCase()) ?? []

        return title ?? addr
      }

      requireCondAndStake(requireStakeSlot != null, entStakes,
        `unstaked ${entityTitle} accessed ${nameAddr(addr, entityTitle)} slot ${requireStakeSlot}`)
    })

    if (entityTitle === 'paymaster') {
      const validatePaymasterUserOp = callStack.find(call => call.method === 'validatePaymasterUserOp' && call.to === entityAddr)
      const context = validatePaymasterUserOp?.return?.context
      requireCondAndStake(context != null && context !== '0x', entStakes,
        'unstaked paymaster must not return context')
    }

    // helper method: if condition is true, then entity must be staked.
    function requireCondAndStake (cond: boolean, entStake: StakeInfo | undefined, failureMessage: string): void {
      if (!cond) {
        return
      }
      if (entStakes == null) {
        throw new Error(`internal: ${entityTitle} not in userOp, but has storage accesses in ${JSON.stringify(access)}`)
      }
      requireCond(BigNumber.from(1).lt(entStakes.stake) && BigNumber.from(1).lt(entStakes.unstakeDelaySec),
        failureMessage, ValidationErrors.OpcodeValidation, { [entityTitle]: entStakes?.addr })

      // TODO: check real minimum stake values
    }

    // the only contract we allow to access before its deployment is the "sender" itself, which gets created.
    requireCond(Object.keys(currentNumLevel.contractSize).find(addr => addr !== sender && currentNumLevel.contractSize[addr] <= 2) == null,
      `${entityTitle} accesses un-deployed contract ${JSON.stringify(currentNumLevel.contractSize)}`, ValidationErrors.OpcodeValidation)
  })

  // return list of contract addresses by this UserOp. already known not to contain zero-sized addresses.
  const addresses = tracerResults.callsFromEntryPoint.flatMap(level => Object.keys(level.contractSize))
  const storageMap: StorageMap = {}
  tracerResults.callsFromEntryPoint.forEach(level => {
    Object.keys(level.access).forEach(addr => {
      storageMap[addr] = storageMap[addr] ?? level.access[addr].reads
    })
  })
  return [addresses, storageMap]
}
