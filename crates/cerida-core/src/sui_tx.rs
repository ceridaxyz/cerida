// Copyright (c) Cerida
// SPDX-License-Identifier: Apache-2.0
//
// Minimal Sui Programmable Transaction Block (PTB) types, BCS serialization,
// and intent-based signing. No dependency on the Sui monorepo — just `bcs`,
// `ed25519-dalek`, and `blake2`.
//
// Encoding follows:
//   https://github.com/MystenLabs/sui/blob/main/crates/sui-types/src/transaction.rs
//   https://github.com/MystenLabs/sui/blob/main/crates/sui-types/src/intent.rs

use anyhow::{bail, Result};
use base64::Engine as _;
use blake2::{Blake2b, Digest};
use ed25519_dalek::{Signer, SigningKey};
use serde::{Deserialize, Serialize};

// ── Address / Object ID ──────────────────────────────────────────────────────

/// 32-byte Sui address or object ID.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SuiAddress(pub [u8; 32]);

pub type ObjectID = SuiAddress;

/// Hex string → SuiAddress (accepts "0x..." or raw hex).
pub fn parse_object_id(s: &str) -> Result<ObjectID> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    let bytes = hex::decode(s)?;
    if bytes.len() != 32 {
        bail!("object id must be 32 bytes, got {}", bytes.len());
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&bytes);
    Ok(SuiAddress(arr))
}

// ── Object references ────────────────────────────────────────────────────────

/// u64 lamport version / sequence number.
pub type SequenceNumber = u64;

/// 32-byte object content digest.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ObjectDigest(pub [u8; 32]);

/// (id, version, digest) — used for owned / immutable object references.
pub type ObjectRef = (ObjectID, SequenceNumber, ObjectDigest);

// ── Call arguments ───────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SharedObjectArg {
    pub id: ObjectID,
    pub initial_shared_version: SequenceNumber,
    pub mutable: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum ObjectArg {
    /// Owned or immutable object.
    ImmOrOwnedObject(ObjectRef),
    /// Shared object.
    SharedObject(SharedObjectArg),
    // Receiving variant omitted — not used here.
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum CallArg {
    Object(ObjectArg),
    /// BCS-encoded pure value.
    Pure(Vec<u8>),
}

// ── Type tags ────────────────────────────────────────────────────────────────

/// Mirrors Move's AccountAddress (32 bytes).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AccountAddress(pub [u8; 32]);

/// Move identifier (validated non-empty ASCII string).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Identifier(pub String);

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StructTag {
    pub address: AccountAddress,
    pub module: Identifier,
    pub name: Identifier,
    pub type_params: Vec<TypeTag>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum TypeTag {
    Bool,
    U8,
    U64,
    U128,
    Address,
    Signer,
    Vector(Box<TypeTag>),
    Struct(Box<StructTag>),
    U16,
    U32,
    U256,
}

/// Parse a Move type string such as `0x2::sui::SUI` or
/// `0xabcd::package::Module<0x2::sui::SUI>` into a `TypeTag`.
pub fn parse_type_tag(s: &str) -> Result<TypeTag> {
    let s = s.trim();
    // Primitive types
    match s {
        "bool" => return Ok(TypeTag::Bool),
        "u8" => return Ok(TypeTag::U8),
        "u16" => return Ok(TypeTag::U16),
        "u32" => return Ok(TypeTag::U32),
        "u64" => return Ok(TypeTag::U64),
        "u128" => return Ok(TypeTag::U128),
        "u256" => return Ok(TypeTag::U256),
        "address" => return Ok(TypeTag::Address),
        _ => {}
    }
    if let Some(inner) = s.strip_prefix("vector<").and_then(|s| s.strip_suffix('>')) {
        return Ok(TypeTag::Vector(Box::new(parse_type_tag(inner)?)));
    }
    // Struct: 0xADDR::module::Name<...>
    parse_struct_tag(s).map(|st| TypeTag::Struct(Box::new(st)))
}

fn parse_struct_tag(s: &str) -> Result<StructTag> {
    // Split off type params if present
    let (base, type_params) = if let Some(bracket) = s.find('<') {
        let params_str = s[bracket + 1..].strip_suffix('>').ok_or_else(|| {
            anyhow::anyhow!("unmatched < in type tag: {s}")
        })?;
        let params = split_type_params(params_str)
            .iter()
            .map(|p| parse_type_tag(p))
            .collect::<Result<Vec<_>>>()?;
        (&s[..bracket], params)
    } else {
        (s, vec![])
    };

    let parts: Vec<&str> = base.splitn(3, "::").collect();
    if parts.len() != 3 {
        bail!("invalid struct tag: {s}");
    }
    let addr_str = parts[0].strip_prefix("0x").unwrap_or(parts[0]);
    let addr_bytes = hex::decode(format!("{:0>64}", addr_str))?;
    let mut addr = [0u8; 32];
    addr.copy_from_slice(&addr_bytes);

    Ok(StructTag {
        address: AccountAddress(addr),
        module: Identifier(parts[1].to_string()),
        name: Identifier(parts[2].to_string()),
        type_params,
    })
}

/// Split comma-separated type params respecting nested angle brackets.
fn split_type_params(s: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut depth = 0usize;
    let mut start = 0;
    for (i, c) in s.char_indices() {
        match c {
            '<' => depth += 1,
            '>' => depth = depth.saturating_sub(1),
            ',' if depth == 0 => {
                result.push(s[start..i].trim().to_string());
                start = i + 1;
            }
            _ => {}
        }
    }
    let last = s[start..].trim();
    if !last.is_empty() {
        result.push(last.to_string());
    }
    result
}

// ── PTB arguments ────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub enum Argument {
    /// The gas coin object.
    GasCoin,
    /// An input at the given index in `inputs`.
    Input(u16),
    /// The result of a previous command.
    Result(u16),
    /// A nested result (command index, result index).
    NestedResult(u16, u16),
}

// ── Commands ─────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProgrammableMoveCall {
    pub package: ObjectID,
    pub module: Identifier,
    pub function: Identifier,
    pub type_arguments: Vec<TypeTag>,
    pub arguments: Vec<Argument>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum Command {
    MoveCall(Box<ProgrammableMoveCall>),
    TransferObjects(Vec<Argument>, Argument),
    SplitCoins(Argument, Vec<Argument>),
    MergeCoins(Argument, Vec<Argument>),
    Publish(Vec<Vec<u8>>, Vec<ObjectID>),
    MakeMoveVec(Option<TypeTag>, Vec<Argument>),
    Upgrade(Vec<Vec<u8>>, Vec<ObjectID>, ObjectID, Argument),
}

// ── Programmable transaction ─────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProgrammableTransaction {
    pub inputs: Vec<CallArg>,
    pub commands: Vec<Command>,
}

// ── Transaction data ─────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum TransactionKind {
    /// Unused variants keep the enum discriminants aligned with Sui's encoding.
    /// Only `ProgrammableTransaction` (variant 0) is used here.
    ProgrammableTransaction(ProgrammableTransaction),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GasData {
    pub payment: Vec<ObjectRef>,
    pub owner: SuiAddress,
    pub price: u64,
    pub budget: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum TransactionExpiration {
    None,
    Epoch(u64),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TransactionDataV1 {
    pub kind: TransactionKind,
    pub sender: SuiAddress,
    pub gas_data: GasData,
    pub expiration: TransactionExpiration,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum TransactionData {
    V1(TransactionDataV1),
}

// ── Builder ──────────────────────────────────────────────────────────────────

/// Ergonomic PTB builder.
pub struct PtbBuilder {
    inputs: Vec<CallArg>,
    commands: Vec<Command>,
}

impl PtbBuilder {
    pub fn new() -> Self {
        Self { inputs: vec![], commands: vec![] }
    }

    /// Add a shared object input and return its `Argument::Input(n)`.
    pub fn shared(&mut self, id: ObjectID, initial_shared_version: u64, mutable: bool) -> Argument {
        let idx = self.inputs.len() as u16;
        self.inputs.push(CallArg::Object(ObjectArg::SharedObject(SharedObjectArg {
            id,
            initial_shared_version,
            mutable,
        })));
        Argument::Input(idx)
    }

    /// Add a pure u64 input.
    pub fn pure_u64(&mut self, v: u64) -> Argument {
        let idx = self.inputs.len() as u16;
        self.inputs.push(CallArg::Pure(bcs::to_bytes(&v).unwrap()));
        Argument::Input(idx)
    }

    /// Add a pure bool input.
    pub fn pure_bool(&mut self, v: bool) -> Argument {
        let idx = self.inputs.len() as u16;
        self.inputs.push(CallArg::Pure(bcs::to_bytes(&v).unwrap()));
        Argument::Input(idx)
    }

    /// Add an owned (or immutable) object input — used for AdminCap, OracleSVICap, etc.
    pub fn owned(&mut self, id: ObjectID, version: SequenceNumber, digest: ObjectDigest) -> Argument {
        let idx = self.inputs.len() as u16;
        self.inputs.push(CallArg::Object(ObjectArg::ImmOrOwnedObject((id, version, digest))));
        Argument::Input(idx)
    }

    /// Add a pure UTF-8 string (BCS: ULEB128 length + bytes).
    pub fn pure_string(&mut self, s: &str) -> Argument {
        let idx = self.inputs.len() as u16;
        self.inputs.push(CallArg::Pure(bcs::to_bytes(s).unwrap()));
        Argument::Input(idx)
    }

    /// Add a Move `ID` (= `address`) input — BCS-encoded as 32 raw bytes.
    pub fn pure_address(&mut self, bytes: [u8; 32]) -> Argument {
        let idx = self.inputs.len() as u16;
        self.inputs.push(CallArg::Pure(bytes.to_vec()));
        Argument::Input(idx)
    }

    /// Add a Move `vector<u64>` input (BCS: ULEB128 length + LE u64 values).
    pub fn pure_u64_vec(&mut self, v: &[u64]) -> Argument {
        let idx = self.inputs.len() as u16;
        self.inputs.push(CallArg::Pure(bcs::to_bytes(v).unwrap()));
        Argument::Input(idx)
    }

    /// Append a MoveCall and return `Result(cmd_index)` so the output can be
    /// passed as an argument to a subsequent command in the same PTB.
    pub fn move_call_result(
        &mut self,
        package: ObjectID,
        module: &str,
        function: &str,
        type_arguments: Vec<TypeTag>,
        arguments: Vec<Argument>,
    ) -> Argument {
        let cmd_idx = self.commands.len() as u16;
        self.commands.push(Command::MoveCall(Box::new(ProgrammableMoveCall {
            package,
            module: Identifier(module.to_string()),
            function: Identifier(function.to_string()),
            type_arguments,
            arguments,
        })));
        Argument::Result(cmd_idx)
    }

    /// Append a MoveCall command.
    pub fn move_call(
        &mut self,
        package: ObjectID,
        module: &str,
        function: &str,
        type_arguments: Vec<TypeTag>,
        arguments: Vec<Argument>,
    ) {
        self.commands.push(Command::MoveCall(Box::new(ProgrammableMoveCall {
            package,
            module: Identifier(module.to_string()),
            function: Identifier(function.to_string()),
            type_arguments,
            arguments,
        })));
    }

    pub fn finish(self) -> ProgrammableTransaction {
        ProgrammableTransaction { inputs: self.inputs, commands: self.commands }
    }
}

// ── Signing ──────────────────────────────────────────────────────────────────

/// Sui's intent prefix for transaction data: [scope=0, version=0, app_id=0].
const INTENT_PREFIX: [u8; 3] = [0, 0, 0];

/// Ed25519 signature flag byte.
const SIG_FLAG_ED25519: u8 = 0x00;

/// Parse a bech32 Sui private key (`suiprivkey1...`) or 64-char hex.
pub fn load_signing_key(raw: &str) -> Result<SigningKey> {
    // Sui bech32 private key format: suiprivkey1<bech32(flag || 32_byte_key)>
    if raw.starts_with("suiprivkey1") {
        let (_, data_u5, _variant) = bech32::decode(raw)
            .map_err(|e| anyhow::anyhow!("bech32 decode: {e}"))?;
        let data = bech32::convert_bits(&data_u5, 5, 8, false)
            .map_err(|e| anyhow::anyhow!("bech32 convert_bits: {e}"))?;
        // data = [flag_byte, ...32 bytes key]
        if data.len() < 33 {
            bail!("bech32 key too short");
        }
        let key_bytes: [u8; 32] = data[1..33].try_into()?;
        return Ok(SigningKey::from_bytes(&key_bytes));
    }
    // Raw 64-char hex
    let bytes = hex::decode(raw.trim())?;
    if bytes.len() != 32 {
        bail!("private key must be 32 bytes");
    }
    Ok(SigningKey::from_bytes(bytes.as_slice().try_into()?))
}

/// Sign `tx_data` and return `(base64_tx_bytes, base64_signature)`.
pub fn sign_transaction(
    signing_key: &SigningKey,
    tx_data: &TransactionData,
) -> Result<(String, String)> {
    let tx_bytes = bcs::to_bytes(tx_data)?;

    // Intent message = intent_prefix || bcs(tx_data)
    let mut intent_msg = Vec::with_capacity(3 + tx_bytes.len());
    intent_msg.extend_from_slice(&INTENT_PREFIX);
    intent_msg.extend_from_slice(&tx_bytes);

    // Hash with Blake2b-256
    let mut hasher = Blake2b::<blake2::digest::typenum::U32>::new();
    hasher.update(&intent_msg);
    let hash = hasher.finalize();

    let sig = signing_key.sign(&hash);
    let pubkey = signing_key.verifying_key();

    // Sui signature: [flag, sig_bytes(64), pubkey_bytes(32)]
    let mut sig_bytes = Vec::with_capacity(1 + 64 + 32);
    sig_bytes.push(SIG_FLAG_ED25519);
    sig_bytes.extend_from_slice(&sig.to_bytes());
    sig_bytes.extend_from_slice(pubkey.as_bytes());

    let b64 = base64::engine::general_purpose::STANDARD;
    Ok((b64.encode(&tx_bytes), b64.encode(&sig_bytes)))
}

/// Return the Sui address (32 bytes) derived from the signing key.
pub fn address_of(key: &SigningKey) -> SuiAddress {
    use blake2::Digest as _;
    // Sui address = Blake2b-256([flag] || pubkey)
    let mut hasher = Blake2b::<blake2::digest::typenum::U32>::new();
    hasher.update([SIG_FLAG_ED25519]);
    hasher.update(key.verifying_key().as_bytes());
    let hash = hasher.finalize();
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&hash);
    SuiAddress(arr)
}

// ── Pure value helpers ───────────────────────────────────────────────────────

/// BCS-encode a u64 as a pure call argument.
pub fn pure_u64(v: u64) -> CallArg {
    CallArg::Pure(bcs::to_bytes(&v).unwrap())
}
