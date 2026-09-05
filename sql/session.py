"""The single Hive-enabled SparkSession builder. Every SQL entry point imports this.

Spec §4.1a requires the Parquet outputs to be reachable from Spark SQL and HiveQL rather
than only by path. pyspark 3.5.3 ships the Hive 2.3.9 jars, so `enableHiveSupport()` works
against an embedded Derby metastore with no extra downloads.

Three placement decisions here are not preferences:

**Derby lives beside the warehouse, never inside it.** `make clean-warehouse` runs
`rm -rf` on `$VC_WAREHOUSE`. A metastore under that path would be destroyed by a routine
cleanup, taking every table definition with it.

**`derby.system.home` is set explicitly.** Otherwise Derby writes `derby.log` into the
process working directory — which is the repository on `/mnt/c`, i.e. across the 9p
boundary, in a directory under version control.

**Embedded Derby is single-writer.** Two Spark sessions cannot hold the metastore at once;
the second dies with "Another instance of Derby may have already booted the database".
The Makefile carries `.NOTPARALLEL:` for this reason — a comment would not be enough,
because `make -j` would otherwise fail in a way that looks like a Spark bug.

State that constraint plainly in reporting too: an embedded metastore demonstrates the
programming model, it is not a shared catalog in any operational sense.
"""
from __future__ import annotations

import os

from pyspark.sql import SparkSession

DB_FULL = "voidcode"
DB_TRAIN = "voidcode_train"


def _data_root() -> str:
    return os.environ.get("VC_DATA", os.path.expanduser("~/voidcode-data"))


def metastore_path() -> str:
    return os.environ.get("VC_METASTORE", os.path.join(_data_root(), "metastore_db"))


def hive_warehouse_path() -> str:
    return os.environ.get("VC_HIVE_WAREHOUSE",
                          os.path.join(_data_root(), "hive_warehouse"))


def warehouse_path(train: bool = False) -> str:
    if train:
        return os.environ.get("VC_WAREHOUSE_TRAIN",
                              os.path.join(_data_root(), "warehouse_train"))
    return os.environ.get("VC_WAREHOUSE", os.path.join(_data_root(), "warehouse"))


def build_session(app_name: str = "voidcode-sql", cores: int | None = None,
                  driver_mem: str = "8g") -> SparkSession:
    cores = cores or (os.cpu_count() or 4)
    data_root = _data_root()
    os.makedirs(hive_warehouse_path(), exist_ok=True)

    return (SparkSession.builder
            .appName(app_name)
            .master(f"local[{cores}]")
            .enableHiveSupport()
            # The `spark.hadoop.` prefix is required. Passing bare `javax.jdo.*` keys
            # to SparkConf makes Spark log "Ignoring non-Spark config property" and
            # drop them — the metastore then lands wherever `derby.system.home`
            # happens to point. That produced the *right* directory here purely by
            # coincidence, which is the kind of accident that survives until someone
            # changes VC_METASTORE and cannot work out why it had no effect.
            .config("spark.hadoop.javax.jdo.option.ConnectionURL",
                    f"jdbc:derby:;databaseName={metastore_path()};create=true")
            .config("spark.hadoop.javax.jdo.option.ConnectionDriverName",
                    "org.apache.derby.jdbc.EmbeddedDriver")
            .config("spark.sql.warehouse.dir", hive_warehouse_path())
            # Keep derby.log out of the repo working directory.
            .config("spark.driver.extraJavaOptions",
                    f"-Dderby.system.home={data_root}")
            .config("spark.driver.memory", driver_mem)
            .config("spark.sql.shuffle.partitions", cores * 4)
            .config("spark.sql.session.timeZone", "UTC")
            .config("spark.sql.parquet.compression.codec", "snappy")
            .getOrCreate())
