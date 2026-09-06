"""Deliberately empty. Stands in for `__main__` while a grading child is started.

`multiprocessing` rebuilds the parent's `__main__` inside every spawn/forkserver child, by running
it through `runpy` before the target is unpickled. When the parent is train_grpo.py or
filter_corpus.py that means a full torch import per grading call. `reward.limits._light_main`
points `__main__.__file__` here for the duration of `Process.start()`, so the child runs this
instead. It must stay empty, and it must keep existing -- `runpy.run_path` needs a real file.
"""
