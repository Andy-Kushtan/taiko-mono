import { ethers } from "ethers";
import { TaikoL1, TaikoL2 } from "../../typechain";
import { BlockProvenEvent } from "../../typechain/LibProving";
import { BlockMetadata } from "./block_metadata";
import { encodeEvidence } from "./encoding";
import Evidence from "./evidence";
import { BlockHeader, getBlockHeader } from "./rpc";

const buildProveBlockInputs = (
    meta: BlockMetadata,
    header: BlockHeader,
    prover: string,
    anchorTx: Uint8Array | string,
    anchorReceipt: Uint8Array | string,
    zkProofsPerBlock: number
) => {
    const inputs = [];
    const evidence: Evidence = {
        meta: meta,
        header: header,
        prover: prover,
        proofs: [],
    };

    // we have mkp + zkp returnign true in testing, so can just push 0xff
    // instead of actually making proofs for anchor tx, anchor receipt, and
    // zkp
    for (let i = 0; i < zkProofsPerBlock + 2; i++) {
        evidence.proofs.push("0xff");
    }

    inputs[0] = encodeEvidence(evidence);
    inputs[1] = anchorTx;
    inputs[2] = anchorReceipt;
    return inputs;
};

// TODO
const proveBlock = async (
    taikoL1: TaikoL1,
    taikoL2: TaikoL2,
    l2Signer: ethers.Signer,
    l2Provider: ethers.providers.JsonRpcProvider,
    proverAddress: string,
    blockId: number,
    blockNumber: number,
    meta: BlockMetadata
): Promise<BlockProvenEvent> => {
    const config = await taikoL1.getConfig();
    const header = await getBlockHeader(l2Provider, blockNumber);
    // header.blockHeader.difficulty = 0;
    // header.blockHeader.gasLimit = config.anchorTxGasLimit
    //     .add(header.blockHeader.gasLimit)
    //     .toNumber();
    // header.blockHeader.timestamp = meta.timestamp;
    // // cant prove non-0 blocks
    // if (header.blockHeader.gasUsed <= 0) {
    //     header.blockHeader.gasUsed = 1;
    // }
    // header.blockHeader.mixHash = meta.mixHash;
    // header.blockHeader.extraData = meta.extraData;

    const inputs = buildProveBlockInputs(
        meta,
        header.blockHeader,
        proverAddress,
        "0x",
        "0x",
        config.zkProofsPerBlock.toNumber()
    );
    const tx = await taikoL1.proveBlock(blockId, inputs);
    const receipt = await tx.wait(1);
    const event: BlockProvenEvent = (receipt.events as any[]).find(
        (e) => e.event === "BlockProven"
    );
    return event;
};

export { buildProveBlockInputs, proveBlock };
