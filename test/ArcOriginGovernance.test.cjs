const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const USDC = 10n ** 6n;
const TWO_DAYS = 2n * 24n * 60n * 60n;
const ZERO_BYTES32 = ethers.ZeroHash;

describe("ArcOrigin governance", function () {
  async function deployPlatform() {
    const [deployer, safe, executor, recipient] = await ethers.getSigners();
    const Mock = await ethers.getContractFactory("MockUSDC");
    const usdc = await Mock.deploy();
    const Vault = await ethers.getContractFactory("ArcForgeFeeVault");
    const vault = await Vault.deploy(deployer.address, deployer.address);
    const Registry = await ethers.getContractFactory("ArcForgeCreatorRegistry");
    const registry = await Registry.deploy(deployer.address);
    const Factory = await ethers.getContractFactory("ArcForgeFactoryV5");
    const factory = await Factory.deploy(
      deployer.address,
      await usdc.getAddress(),
      await vault.getAddress(),
      await registry.getAddress(),
      10n * USDC,
      2_500n * USDC,
      10_000n * USDC,
    );
    await registry.setFactory(await factory.getAddress());

    const Timelock = await ethers.getContractFactory("ArcOriginGovernanceTimelock");
    const timelock = await Timelock.deploy(TWO_DAYS, safe.address);
    return { deployer, safe, executor, recipient, vault, registry, factory, timelock };
  }

  it("uses a self-administered 48-hour delay with one Safe proposer and open execution", async function () {
    const { deployer, safe, timelock } = await deployPlatform();
    const proposerRole = await timelock.PROPOSER_ROLE();
    const cancellerRole = await timelock.CANCELLER_ROLE();
    const executorRole = await timelock.EXECUTOR_ROLE();
    const adminRole = await timelock.DEFAULT_ADMIN_ROLE();

    expect(await timelock.getMinDelay()).to.equal(TWO_DAYS);
    expect(await timelock.hasRole(proposerRole, safe.address)).to.equal(true);
    expect(await timelock.hasRole(cancellerRole, safe.address)).to.equal(true);
    expect(await timelock.hasRole(executorRole, ethers.ZeroAddress)).to.equal(true);
    expect(await timelock.hasRole(adminRole, await timelock.getAddress())).to.equal(true);
    expect(await timelock.hasRole(adminRole, deployer.address)).to.equal(false);
    expect(await timelock.hasRole(adminRole, safe.address)).to.equal(false);
  });

  it("blocks direct administration after ownership transfer and enforces the full delay", async function () {
    const { deployer, safe, executor, recipient, vault, registry, factory, timelock } = await deployPlatform();
    const timelockAddress = await timelock.getAddress();
    await vault.setFeeRecipient(recipient.address);
    await factory.transferOwnership(timelockAddress);
    await registry.transferOwnership(timelockAddress);
    await vault.transferOwnership(timelockAddress);

    await expect(factory.connect(deployer).setLaunchFee(5n * USDC))
      .to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount")
      .withArgs(deployer.address);
    await expect(factory.connect(safe).setLaunchFee(5n * USDC))
      .to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount")
      .withArgs(safe.address);
    await expect(registry.connect(deployer).setFactory(deployer.address))
      .to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount")
      .withArgs(deployer.address);
    await expect(vault.connect(deployer).setFeeRecipient(deployer.address))
      .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount")
      .withArgs(deployer.address);

    const data = factory.interface.encodeFunctionData("setLaunchFee", [5n * USDC]);
    const salt = ethers.id("lower-launch-fee");
    await timelock.connect(safe).schedule(
      await factory.getAddress(),
      0,
      data,
      ZERO_BYTES32,
      salt,
      TWO_DAYS,
    );
    await expect(timelock.connect(executor).execute(
      await factory.getAddress(),
      0,
      data,
      ZERO_BYTES32,
      salt,
    )).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");

    await time.increase(TWO_DAYS);
    await timelock.connect(executor).execute(
      await factory.getAddress(),
      0,
      data,
      ZERO_BYTES32,
      salt,
    );
    expect(await factory.launchFee()).to.equal(5n * USDC);
  });

  it("rejects a zero Safe proposer", async function () {
    const Timelock = await ethers.getContractFactory("ArcOriginGovernanceTimelock");
    await expect(Timelock.deploy(TWO_DAYS, ethers.ZeroAddress))
      .to.be.revertedWithCustomError(Timelock, "ZeroAddress");
  });

  it("rejects an initial delay below 48 hours", async function () {
    const [, safe] = await ethers.getSigners();
    const Timelock = await ethers.getContractFactory("ArcOriginGovernanceTimelock");
    await expect(Timelock.deploy(TWO_DAYS - 1n, safe.address))
      .to.be.revertedWithCustomError(Timelock, "DelayTooShort");
  });
});
