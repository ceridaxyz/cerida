module cerida::manager {
    use sui::object::{Self, UID};
    use sui::transfer;
    use sui::tx_context::{Self, TxContext};

    /// One-time witness used in `init`
    public struct MANAGER has drop {}

    /// Admin capability — holder can perform privileged operations across modules
    public struct AdminCap has key, store {
        id: UID,
    }

    fun init(_: MANAGER, ctx: &mut TxContext) {
        transfer::transfer(
            AdminCap { id: object::new(ctx) },
            tx_context::sender(ctx),
        );
    }

    /// Burn the cap to permanently renounce admin rights
    public fun destroy(cap: AdminCap) {
        let AdminCap { id } = cap;
        object::delete(id);
    }
}
